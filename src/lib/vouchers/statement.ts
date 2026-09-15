import { db } from "@/lib/db";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { createPaymentLinkInTx, paymentLinkPath } from "@/lib/paymentLinks";
import { formatVoucherCode } from "./code";
import { sendVoucherStatementEmail } from "./statementEmail";

/**
 * Reporte de bonos usados y CORTE (VoucherStatement).
 *
 * Un corte agrupa las redenciones de UNA empresa en un rango de fechas
 * que todavía no entraron en ningún corte anterior (statementId null):
 * cerrar dos veces el mismo rango no duplica nada, y una redención
 * llega a un solo corte. Lo redimido de lotes a CRÉDITO es lo que se
 * cobra con el link de pago; lo de lotes prepagados ya estaba pagado y
 * sólo se informa.
 */

export type ReportFilter = {
  restaurantId: string;
  billingCustomerId?: string | null;
  from: Date;
  /** Exclusivo (fin del día siguiente al elegido). */
  to: Date;
};

export type ReportRow = {
  id: string;
  redeemedAt: Date;
  code: string;
  orderId: string;
  orderCode: string;
  amountCents: number;
  /** Saldo ACTUAL del bono (lo que le queda para otra visita). */
  voucherBalanceCents: number;
  mode: "prepaid" | "credit";
  channel: "diner" | "staff";
  customerId: string;
  customerName: string;
  statementId: string | null;
};

const BOGOTA_OFFSET_MS = 5 * 60 * 60 * 1000;

/** "YYYY-MM-DD" (día Bogotá) → inicio del día en UTC. null si está mal. */
export function parseDayStart(s: string | null | undefined): Date | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number);
  const utcMidnight = Date.UTC(y, m - 1, d);
  if (Number.isNaN(utcMidnight)) return null;
  return new Date(utcMidnight + BOGOTA_OFFSET_MS);
}

/** Rango [from, to) a partir de dos días Bogotá inclusive. */
export function dayRange(fromDay: string | null | undefined, toDay: string | null | undefined): { from: Date; to: Date } | null {
  const from = parseDayStart(fromDay);
  const toStart = parseDayStart(toDay);
  if (!from || !toStart) return null;
  const to = new Date(toStart.getTime() + 24 * 60 * 60 * 1000);
  if (to.getTime() <= from.getTime()) return null;
  return { from, to };
}

export async function loadVoucherReport(filter: ReportFilter): Promise<ReportRow[]> {
  const rows = await db.voucherRedemption.findMany({
    where: {
      restaurantId: filter.restaurantId,
      redeemedAt: { gte: filter.from, lt: filter.to },
      ...(filter.billingCustomerId
        ? { voucher: { batch: { billingCustomerId: filter.billingCustomerId } } }
        : {}),
    },
    orderBy: { redeemedAt: "desc" },
    take: 2000,
    select: {
      id: true,
      redeemedAt: true,
      amountCents: true,
      channel: true,
      statementId: true,
      orderId: true,
      order: { select: { shortCode: true } },
      voucher: {
        select: {
          code: true,
          balanceCents: true,
          batch: {
            select: {
              mode: true,
              billingCustomerId: true,
              billingCustomer: { select: { customerName: true } },
            },
          },
        },
      },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    redeemedAt: r.redeemedAt,
    code: formatVoucherCode(r.voucher.code),
    orderId: r.orderId,
    orderCode: r.order.shortCode,
    amountCents: r.amountCents,
    voucherBalanceCents: r.voucher.balanceCents,
    mode: r.voucher.batch.mode,
    channel: r.channel,
    customerId: r.voucher.batch.billingCustomerId,
    customerName: r.voucher.batch.billingCustomer.customerName,
    statementId: r.statementId,
  }));
}

export type CloseStatementResult =
  | { ok: true; statementId: string; totalCents: number; creditCents: number; count: number; paymentLinkToken: string | null }
  | { ok: false; error: "customer_not_found" | "nothing_to_close" };

export async function closeVoucherStatement(args: {
  restaurantId: string;
  billingCustomerId: string;
  from: Date;
  to: Date;
  userId: string | null;
}): Promise<CloseStatementResult> {
  const customer = await db.billingCustomer.findFirst({
    where: { id: args.billingCustomerId, restaurantId: args.restaurantId },
    select: { id: true },
  });
  if (!customer) return { ok: false, error: "customer_not_found" };
  const restaurant = await db.restaurant.findUniqueOrThrow({
    where: { id: args.restaurantId },
    select: { country: true },
  });
  const currency = await getCurrencyForCountry(restaurant.country);

  return db.$transaction(async (tx) => {
    // Serializa dos cierres simultáneos de la misma empresa.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${args.restaurantId + ":" + customer.id}), 917)`;
    const pending = await tx.voucherRedemption.findMany({
      where: {
        restaurantId: args.restaurantId,
        statementId: null,
        redeemedAt: { gte: args.from, lt: args.to },
        voucher: { batch: { billingCustomerId: customer.id } },
      },
      select: { id: true, amountCents: true, voucher: { select: { batch: { select: { mode: true } } } } },
    });
    if (pending.length === 0) return { ok: false as const, error: "nothing_to_close" as const };
    const totalCents = pending.reduce((s, r) => s + r.amountCents, 0);
    const creditCents = pending
      .filter((r) => r.voucher.batch.mode === "credit")
      .reduce((s, r) => s + r.amountCents, 0);
    const prepaidCents = totalCents - creditCents;
    const statement = await tx.voucherStatement.create({
      data: {
        restaurantId: args.restaurantId,
        billingCustomerId: customer.id,
        periodFrom: args.from,
        periodTo: args.to,
        totalCents,
        creditCents,
        prepaidCents,
        redemptionCount: pending.length,
        // Sin crédito no hay nada que cobrar: nace pagado.
        status: creditCents > 0 ? "open" : "paid",
        paidAt: creditCents > 0 ? null : new Date(),
        createdByUserId: args.userId,
      },
    });
    await tx.voucherRedemption.updateMany({
      where: { id: { in: pending.map((r) => r.id) } },
      data: { statementId: statement.id },
    });
    let token: string | null = null;
    if (creditCents > 0) {
      const link = await createPaymentLinkInTx(tx, {
        restaurantId: args.restaurantId,
        kind: "voucher_statement",
        amountCents: creditCents,
        currency,
        voucherStatementId: statement.id,
      });
      token = link.token;
    }
    return {
      ok: true as const,
      statementId: statement.id,
      totalCents,
      creditCents,
      count: pending.length,
      paymentLinkToken: token,
    };
  });
}

/** Manda (o re-manda) el correo del corte. Best-effort; nunca lanza. */
export async function emailVoucherStatement(args: {
  restaurantId: string;
  statementId: string;
  origin: string;
  locale?: string | null;
}): Promise<boolean> {
  const st = await db.voucherStatement.findFirst({
    where: { id: args.statementId, restaurantId: args.restaurantId },
    include: {
      restaurant: { select: { name: true, slug: true, country: true } },
      billingCustomer: { select: { customerName: true, email: true } },
      paymentLink: { select: { token: true, status: true } },
      redemptions: {
        orderBy: { redeemedAt: "asc" },
        select: {
          redeemedAt: true,
          amountCents: true,
          voucher: { select: { code: true } },
          order: { select: { shortCode: true } },
        },
      },
    },
  });
  if (!st) return false;
  const currency = await getCurrencyForCountry(st.restaurant.country);
  const paymentUrl =
    st.paymentLink && st.paymentLink.status === "pending"
      ? `${args.origin}${paymentLinkPath(st.restaurant.slug, st.paymentLink.token)}`
      : null;
  try {
    const sent = await sendVoucherStatementEmail({
      to: st.billingCustomer.email,
      locale: args.locale,
      restaurantName: st.restaurant.name,
      customerName: st.billingCustomer.customerName,
      periodFrom: st.periodFrom,
      // periodTo es exclusivo (inicio del día siguiente): al humano se le
      // muestra el último día incluido.
      periodTo: new Date(st.periodTo.getTime() - 1),
      totalCents: st.totalCents,
      creditCents: st.creditCents,
      prepaidCents: st.prepaidCents,
      currency,
      rows: st.redemptions.map((r) => ({
        redeemedAt: r.redeemedAt,
        code: formatVoucherCode(r.voucher.code),
        orderCode: r.order.shortCode,
        amountCents: r.amountCents,
      })),
      paymentUrl,
    });
    if (sent) {
      await db.voucherStatement.update({
        where: { id: st.id },
        data: { emailSentAt: new Date() },
      });
    }
    return sent;
  } catch (err) {
    console.error("[vouchers] statement email failed", { statementId: st.id, err });
    return false;
  }
}
