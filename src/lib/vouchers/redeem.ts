import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { publishOrderEvent } from "@/lib/events";
import { issueInvoiceOnPaid } from "@/lib/invoiceOnPaid";
import { notifyAutoFiredTickets } from "@/lib/kds/autoFireTickets";
import { isModuleEnabled } from "@/lib/modules";
import { lockOrder } from "@/lib/orderLock";
import { computeOrderTotals, recomputeOrderTotalsInTx } from "@/lib/orderTotals";
import { activateOpenRounds } from "@/lib/prepaidRounds";
import {
  assertNoPaymentInFlightHolding,
  releasePaymentRequests,
  staffOutstanding,
} from "@/lib/payments/staffCharge";
import { formatVoucherCode, looksLikeVoucherCode, normalizeVoucherCode } from "./code";
import { voucherApplicableCents, voucherRedeemability } from "./validate";

/**
 * Redención de un bono como forma de pago de una cuenta.
 *
 * Una sola función para los dos canales (comensal desde su portal, staff
 * desde el cobro): transaccional con `lockOrder` + bloqueo del bono, y
 * el saldo se descuenta con un updateMany CONDICIONADO por saldo (si
 * dos cuentas usan el mismo bono a la vez, una de las dos ve count=0 y
 * no aplica). Idempotente por (bono, orden): la misma orden no puede
 * aplicar el mismo bono dos veces — la segunda llamada devuelve lo que
 * ya se aplicó.
 *
 * Cuánto se aplica: el menor entre el saldo del bono y lo pendiente de
 * la cuenta (contando pagos aprobados Y pendientes, como el resto de los
 * cobros). Si la cuenta es mayor el comensal paga la diferencia con
 * cualquier otro medio; si es menor, el saldo queda para la próxima.
 *
 * Canal `staff`: como en todo cobro del staff (ver
 * `@/lib/payments/staffCharge`), las SOLICITUDES del comensal pendientes
 * (efectivo, datáfono propio) no reservan nada —el bono las reemplaza y se
 * declinan al aplicarlo— y si lo único que no deja aplicar el bono es un
 * pago en línea en curso, sale el 409 `pending_payment_in_flight`.
 * Sin propina: el bono paga comida; la propina, si la deja, va en el
 * pago del resto.
 *
 * Con el módulo apagado responde `module_disabled` aunque el código
 * exista: el módulo es el interruptor, no la UI.
 */
export type RedeemError =
  | "module_disabled"
  | "not_found"
  | "batch_unpaid"
  | "batch_cancelled"
  | "cancelled"
  | "expired"
  | "exhausted"
  | "order_closed"
  | "nothing_outstanding";

export type VoucherPreview = {
  ok: true;
  code: string;
  balanceCents: number;
  applicableCents: number;
  outstandingCents: number;
};

export type RedeemApplied = {
  paymentId: string;
  amountCents: number;
  balanceAfterCents: number;
  outstandingAfterCents: number;
  fullyPaid: boolean;
  alreadyApplied: boolean;
};

export type RedeemOutcome =
  | ({ ok: true; code: string } & RedeemApplied)
  | { ok: false; error: RedeemError };

// Resultado de la transacción, discriminado a mano: con varios `return`
// de literales distintos TS normaliza las formas y `"error" in result`
// dejaría de estrechar.
type TxResult =
  | { error: RedeemError }
  | { applied: RedeemApplied; fired: Awaited<ReturnType<typeof activateOpenRounds>> };

type Located = {
  ok: true;
  voucher: {
    id: string;
    code: string;
    status: "active" | "exhausted" | "cancelled" | "expired";
    balanceCents: number;
    expiresAt: Date | null;
    batch: { mode: "prepaid" | "credit"; status: "issued" | "paid" | "cancelled" };
  };
};

/** Módulo + código → bono redimible de ESTE comercio, o el motivo. */
async function locateVoucher(
  restaurantId: string,
  rawCode: string,
): Promise<Located | { ok: false; error: RedeemError }> {
  const restaurant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { enabledModules: true },
  });
  if (!restaurant || !isModuleEnabled(restaurant.enabledModules, "vouchers")) {
    return { ok: false, error: "module_disabled" };
  }
  const code = normalizeVoucherCode(rawCode);
  if (!looksLikeVoucherCode(code)) return { ok: false, error: "not_found" };
  // El where lleva el restaurantId: el bono de otro comercio "no existe".
  const voucher = await db.voucher.findUnique({
    where: { restaurantId_code: { restaurantId, code } },
    select: {
      id: true,
      code: true,
      status: true,
      balanceCents: true,
      expiresAt: true,
      batch: { select: { mode: true, status: true } },
    },
  });
  if (!voucher) return { ok: false, error: "not_found" };
  const why = voucherRedeemability(voucher, voucher.batch);
  if (why !== "ok") return { ok: false, error: why };
  return { ok: true, voucher };
}

/** Lo pendiente de la cuenta contando aprobados y pendientes (misma regla que validateNewPaymentAmount). */
async function outstandingFor(
  tx: Prisma.TransactionClient | typeof db,
  orderId: string,
): Promise<{ outstandingCents: number; closed: boolean } | null> {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: { subtotalCents: true, taxCents: true, discountCents: true, status: true },
  });
  if (!order) return null;
  if (order.status === "paid" || order.status === "cancelled") {
    return { outstandingCents: 0, closed: true };
  }
  const claims = await tx.payment.findMany({
    where: { orderId, status: { in: ["approved", "pending"] } },
    select: { amountCents: true, tipCents: true },
  });
  const totals = computeOrderTotals(order.subtotalCents, claims, order.taxCents, order.discountCents);
  return { outstandingCents: totals.outstandingCents, closed: false };
}

/** Sólo mira: para mostrar "Bono X · saldo $A · se aplican $B" antes de confirmar. */
export async function previewVoucher(args: {
  restaurantId: string;
  code: string;
  orderId: string;
  channel?: "diner" | "staff";
}): Promise<VoucherPreview | { ok: false; error: RedeemError }> {
  const located = await locateVoucher(args.restaurantId, args.code);
  if (!located.ok) return located;
  const order = await db.order.findFirst({
    where: { id: args.orderId, restaurantId: args.restaurantId },
    select: { id: true },
  });
  if (!order) return { ok: false, error: "order_closed" };
  const staff = args.channel === "staff";
  const outstanding = staff ? await staffOutstanding(db, args.orderId) : await outstandingFor(db, args.orderId);
  if (!outstanding || outstanding.closed) return { ok: false, error: "order_closed" };
  if (outstanding.outstandingCents <= 0) {
    if (staff) await assertNoPaymentInFlightHolding(db, args.orderId);
    return { ok: false, error: "nothing_outstanding" };
  }
  return {
    ok: true,
    code: formatVoucherCode(located.voucher.code),
    balanceCents: located.voucher.balanceCents,
    applicableCents: voucherApplicableCents(
      located.voucher.balanceCents,
      outstanding.outstandingCents,
    ),
    outstandingCents: outstanding.outstandingCents,
  };
}

export async function redeemVoucher(args: {
  restaurantId: string;
  code: string;
  orderId: string;
  channel: "diner" | "staff";
  userId?: string | null;
}): Promise<RedeemOutcome> {
  const located = await locateVoucher(args.restaurantId, args.code);
  if (!located.ok) return located;
  const voucherId = located.voucher.id;
  const code = formatVoucherCode(located.voucher.code);

  const result = await db.$transaction(async (tx): Promise<TxResult> => {
    await lockOrder(tx, args.orderId);
    const order = await tx.order.findFirst({
      where: { id: args.orderId, restaurantId: args.restaurantId },
      select: { id: true, status: true },
    });
    if (!order || order.status === "paid" || order.status === "cancelled") {
      return { error: "order_closed" };
    }

    // Idempotencia: la misma orden ya aplicó este bono → devolver eso.
    const existing = await tx.voucherRedemption.findUnique({
      where: { voucherId_orderId: { voucherId, orderId: order.id } },
      select: { paymentId: true, amountCents: true, voucher: { select: { balanceCents: true } } },
    });
    if (existing?.paymentId) {
      const outstanding = await outstandingFor(tx, order.id);
      return {
        applied: {
          paymentId: existing.paymentId,
          amountCents: existing.amountCents,
          balanceAfterCents: existing.voucher.balanceCents,
          outstandingAfterCents: outstanding?.outstandingCents ?? 0,
          fullyPaid: false,
          alreadyApplied: true,
        },
        fired: [],
      };
    }

    const staff = args.channel === "staff";
    const outstanding = staff ? await staffOutstanding(tx, order.id) : await outstandingFor(tx, order.id);
    if (!outstanding || outstanding.closed) return { error: "order_closed" };
    if (outstanding.outstandingCents <= 0) {
      // Staff: si lo que no deja nada es un pago en línea en curso, decirlo.
      if (staff) await assertNoPaymentInFlightHolding(tx, order.id);
      return { error: "nothing_outstanding" };
    }

    // Bloqueo del bono y re-lectura del saldo bajo el lock: otra cuenta
    // puede haberlo usado entre el preview y acá.
    await tx.$queryRaw`SELECT id FROM "Voucher" WHERE id = ${voucherId} FOR UPDATE`;
    const fresh = await tx.voucher.findUnique({
      where: { id: voucherId },
      select: { balanceCents: true, status: true, expiresAt: true, batch: { select: { mode: true, status: true } } },
    });
    if (!fresh) return { error: "not_found" };
    const why = voucherRedeemability(fresh, fresh.batch);
    if (why !== "ok") return { error: why };
    const amountCents = voucherApplicableCents(fresh.balanceCents, outstanding.outstandingCents);
    if (amountCents <= 0) return { error: "exhausted" };

    // updateMany CONDICIONADO por saldo (patrón claim): si no pega, alguien
    // se adelantó y no se aplica nada.
    const debited = await tx.voucher.updateMany({
      where: { id: voucherId, status: "active", balanceCents: { gte: amountCents } },
      data: { balanceCents: { decrement: amountCents } },
    });
    if (debited.count === 0) return { error: "exhausted" };
    const balanceAfterCents = fresh.balanceCents - amountCents;
    if (balanceAfterCents === 0) {
      await tx.voucher.update({ where: { id: voucherId }, data: { status: "exhausted" } });
    }

    // El staff aplicó el bono: las solicitudes del comensal quedan
    // reemplazadas (y su reserva, liberada antes del INSERT).
    if (staff) await releasePaymentRequests(tx, order.id);
    const payment = await tx.payment.create({
      data: {
        orderId: order.id,
        method: "voucher",
        status: "approved",
        amountCents,
        tipCents: 0,
        providerRef: code,
        settledAt: new Date(),
        collectedByUserId: args.channel === "staff" ? (args.userId ?? null) : null,
      },
    });
    await tx.voucherRedemption.create({
      data: {
        restaurantId: args.restaurantId,
        voucherId,
        orderId: order.id,
        paymentId: payment.id,
        amountCents,
        channel: args.channel,
        redeemedByUserId: args.channel === "staff" ? (args.userId ?? null) : null,
      },
    });
    const totals = await recomputeOrderTotalsInTx(tx, order.id);
    const fired = totals.fullyPaid ? await activateOpenRounds(tx, order.id) : [];
    return {
      applied: {
        paymentId: payment.id,
        amountCents,
        balanceAfterCents,
        outstandingAfterCents: totals.outstandingCents,
        fullyPaid: totals.fullyPaid,
        alreadyApplied: false,
      },
      fired,
    };
  });

  if ("error" in result) return { ok: false, error: result.error };
  const { applied, fired } = result;
  if (!applied.alreadyApplied) {
    publishOrderEvent(args.restaurantId, {
      type: applied.fullyPaid ? "order.paid" : "order.updated",
      orderId: args.orderId,
    });
    await notifyAutoFiredTickets({ restaurantId: args.restaurantId, orderId: args.orderId, rounds: fired });
    if (applied.fullyPaid) {
      await issueInvoiceOnPaid({ tenantId: args.restaurantId, orderId: args.orderId });
    }
  }
  return { ok: true, code, ...applied };
}
