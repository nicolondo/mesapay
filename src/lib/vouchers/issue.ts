import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import {
  createPaymentLinkInTx,
  paymentLinkPath,
} from "@/lib/paymentLinks";
import { generateVoucherCode, voucherPrefix } from "./code";
import { sendVoucherIssueEmail } from "./email";

/**
 * Emisión y cancelación de lotes de bonos. Todo lo que toca la DB del
 * feature pasa por acá; las rutas sólo validan la puerta (módulo + rol)
 * y traducen el resultado a HTTP.
 */

export const MAX_BATCH_QUANTITY = 500;

export const issueBatchSchema = z.object({
  billingCustomerId: z.string().trim().min(1),
  quantity: z.number().int().min(1).max(MAX_BATCH_QUANTITY),
  /** Centavos. Mínimo $1 para que no se emitan bonos en cero por error. */
  unitValueCents: z.number().int().min(100).max(100_000_000_00),
  /** Días de vigencia desde hoy. null = sin vencimiento. */
  expiryDays: z.number().int().min(1).max(3650).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
});

export type IssueBatchInput = z.output<typeof issueBatchSchema>;

export type IssuedBatch = {
  id: string;
  mode: "prepaid" | "credit";
  quantity: number;
  unitValueCents: number;
  totalCents: number;
  paymentLinkToken: string | null;
};

export type IssueResult =
  | { ok: true; batch: IssuedBatch }
  | { ok: false; error: "customer_not_found" | "restaurant_not_found" | "code_collision" };

/** Vigencia: N días desde ahora, al final del día (hora Bogotá). */
export function expiryFromDays(days: number | null | undefined, now = new Date()): Date | null {
  if (!days) return null;
  const d = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  // 23:59:59 Bogotá = 04:59:59 UTC del día siguiente.
  const bogota = new Date(d.getTime() - 5 * 60 * 60 * 1000);
  return new Date(
    Date.UTC(
      bogota.getUTCFullYear(),
      bogota.getUTCMonth(),
      bogota.getUTCDate(),
      23 + 5,
      59,
      59,
    ),
  );
}

export async function issueVoucherBatch(args: {
  restaurantId: string;
  userId: string | null;
  input: IssueBatchInput;
}): Promise<IssueResult> {
  const { restaurantId, userId, input } = args;
  const restaurant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { name: true, country: true, voucherSettings: { select: { mode: true } } },
  });
  if (!restaurant) return { ok: false, error: "restaurant_not_found" };
  // La empresa tiene que ser de ESTE comercio: el id viene del cliente.
  const customer = await db.billingCustomer.findFirst({
    where: { id: input.billingCustomerId, restaurantId },
    select: { id: true },
  });
  if (!customer) return { ok: false, error: "customer_not_found" };

  const mode = restaurant.voucherSettings?.mode ?? "prepaid";
  const prefix = voucherPrefix(restaurant.name);
  const currency = await getCurrencyForCountry(restaurant.country);
  const expiresAt = expiryFromDays(input.expiryDays);
  const totalCents = input.quantity * input.unitValueCents;

  // Colisión de código: el índice único (restaurantId, code) la atrapa y
  // se reintenta el lote entero con códigos nuevos. Con 32^8 por comercio
  // no pasa en la práctica; el bucle es por corrección, no por frecuencia.
  for (let attempt = 0; attempt < 5; attempt++) {
    const codes = new Set<string>();
    while (codes.size < input.quantity) codes.add(generateVoucherCode(prefix));
    try {
      const batch = await db.$transaction(async (tx) => {
        const created = await tx.voucherBatch.create({
          data: {
            restaurantId,
            billingCustomerId: customer.id,
            mode,
            unitValueCents: input.unitValueCents,
            quantity: input.quantity,
            expiresAt,
            note: input.note || null,
            issuedByUserId: userId,
          },
        });
        await tx.voucher.createMany({
          data: [...codes].map((code) => ({
            restaurantId,
            batchId: created.id,
            code,
            valueCents: input.unitValueCents,
            balanceCents: input.unitValueCents,
            expiresAt,
          })),
        });
        let token: string | null = null;
        if (mode === "prepaid") {
          const link = await createPaymentLinkInTx(tx, {
            restaurantId,
            kind: "voucher_batch",
            amountCents: totalCents,
            currency,
            voucherBatchId: created.id,
          });
          token = link.token;
        }
        return { id: created.id, token };
      });
      return {
        ok: true,
        batch: {
          id: batch.id,
          mode,
          quantity: input.quantity,
          unitValueCents: input.unitValueCents,
          totalCents,
          paymentLinkToken: batch.token,
        },
      };
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        continue;
      }
      throw err;
    }
  }
  return { ok: false, error: "code_collision" };
}

/**
 * Manda (o re-manda) el correo de emisión del lote a la empresa. Lee todo
 * de la DB para que "reenviar" y "emitir" produzcan el mismo correo.
 * Best-effort: devuelve false si el mailer no pudo; nunca lanza.
 */
export async function emailVoucherBatch(args: {
  restaurantId: string;
  batchId: string;
  origin: string;
  locale?: string | null;
}): Promise<boolean> {
  const batch = await db.voucherBatch.findFirst({
    where: { id: args.batchId, restaurantId: args.restaurantId },
    include: {
      restaurant: { select: { name: true, slug: true, country: true } },
      billingCustomer: { select: { customerName: true, email: true } },
      vouchers: {
        where: { status: { not: "cancelled" } },
        orderBy: { code: "asc" },
        select: { code: true, valueCents: true },
      },
      paymentLink: { select: { token: true, status: true } },
    },
  });
  if (!batch || batch.status === "cancelled" || batch.vouchers.length === 0) return false;
  const currency = await getCurrencyForCountry(batch.restaurant.country);
  const paymentUrl =
    batch.mode === "prepaid" && batch.paymentLink && batch.paymentLink.status === "pending"
      ? `${args.origin}${paymentLinkPath(batch.restaurant.slug, batch.paymentLink.token)}`
      : null;
  try {
    const sent = await sendVoucherIssueEmail({
      to: batch.billingCustomer.email,
      locale: args.locale,
      restaurantName: batch.restaurant.name,
      customerName: batch.billingCustomer.customerName,
      quantity: batch.vouchers.length,
      unitValueCents: batch.unitValueCents,
      totalCents: batch.vouchers.reduce((s, v) => s + v.valueCents, 0),
      currency,
      expiresAt: batch.expiresAt,
      mode: batch.mode,
      note: batch.note,
      vouchers: batch.vouchers,
      paymentUrl,
    });
    if (sent) {
      await db.voucherBatch.update({
        where: { id: batch.id },
        data: { emailSentAt: new Date() },
      });
    }
    return sent;
  } catch (err) {
    console.error("[vouchers] issue email failed", { batchId: batch.id, err });
    return false;
  }
}

export type CancelVoucherResult = "ok" | "not_found" | "used" | "not_active";

/** Cancela UN bono. Sólo sin uso (saldo intacto y sin redenciones). */
export async function cancelVoucher(args: {
  restaurantId: string;
  voucherId: string;
}): Promise<CancelVoucherResult> {
  const voucher = await db.voucher.findFirst({
    where: { id: args.voucherId, restaurantId: args.restaurantId },
    select: {
      status: true,
      valueCents: true,
      balanceCents: true,
      _count: { select: { redemptions: true } },
    },
  });
  if (!voucher) return "not_found";
  if (voucher._count.redemptions > 0 || voucher.balanceCents !== voucher.valueCents) {
    return "used";
  }
  const r = await db.voucher.updateMany({
    where: { id: args.voucherId, restaurantId: args.restaurantId, status: "active" },
    data: { status: "cancelled", cancelledAt: new Date() },
  });
  return r.count === 1 ? "ok" : "not_active";
}

export type CancelBatchResult =
  | "ok"
  | "not_found"
  | "used"
  | "paid"
  | "already_cancelled";

/**
 * Cancela el lote ENTERO: todos sus bonos y, en prepago, el link de pago.
 * Sólo si ningún bono se usó, y en prepago sólo si todavía no se pagó
 * (un lote pagado es plata recibida: eso se resuelve bono a bono o con
 * una devolución fuera del sistema).
 */
export async function cancelVoucherBatch(args: {
  restaurantId: string;
  batchId: string;
}): Promise<CancelBatchResult> {
  const batch = await db.voucherBatch.findFirst({
    where: { id: args.batchId, restaurantId: args.restaurantId },
    select: { id: true, mode: true, status: true },
  });
  if (!batch) return "not_found";
  if (batch.status === "cancelled") return "already_cancelled";
  if (batch.mode === "prepaid" && batch.status === "paid") return "paid";
  const used = await db.voucherRedemption.count({
    where: { voucher: { batchId: batch.id } },
  });
  if (used > 0) return "used";
  await db.$transaction(async (tx) => {
    const now = new Date();
    await tx.voucherBatch.update({
      where: { id: batch.id },
      data: { status: "cancelled", cancelledAt: now },
    });
    await tx.voucher.updateMany({
      where: { batchId: batch.id, status: "active" },
      data: { status: "cancelled", cancelledAt: now },
    });
    await tx.paymentLink.updateMany({
      where: { voucherBatchId: batch.id, status: "pending" },
      data: { status: "cancelled" },
    });
  });
  return "ok";
}
