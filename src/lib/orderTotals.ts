import type { Prisma, PaymentMethod } from "@prisma/client";
import { db } from "./db";
import { orderTaxTotals } from "./salesTax";
import { computeDiscountCents } from "./dinerDiscount";

/**
 * Single source of truth for how an order's totals are computed from its
 * approved payments. Used by every code path that flips a payment to
 * approved (table-mode pay, cash settle, Kushki webhook, terminal callback).
 *
 * The rules:
 * - tipCents on the order = sum of tipCents across approved payments
 * - totalCents = subtotalCents + taxCents + tipsTotal. taxCents es el
 *   impuesto que las LÍNEAS LIBRES suman encima de su precio (servicios,
 *   bonos); los platos del menú lo llevan embebido y no aportan acá, así que
 *   en una cuenta normal taxCents es 0 y todo funciona como antes.
 * - fullyPaid = (sum of approved amountCents) - tipsTotal >= subtotal + tax
 *   i.e. the food portion of what diners paid covers the bill regardless of
 *   how generous (or stingy) anyone was with the tip
 */

export type OrderRecompute = {
  paidSumCents: number;
  tipsTotalCents: number;
  foodPaidCents: number;
  fullyPaid: boolean;
  outstandingCents: number;
};

export function computeOrderTotals(
  subtotalCents: number,
  approvedPayments: Array<{ amountCents: number; tipCents: number }>,
  /** Impuesto sumado encima (Order.taxCents). 0 en cuentas solo de menú. */
  taxOnTopCents = 0,
  /**
   * Descuento del comensal identificado (Order.discountCents). Baja lo
   * cobrable, así que TIENE que entrar acá y no solo en la vista: si no,
   * el tope de `validateNewPaymentAmount` rechazaría el pago correcto por
   * "excede lo pendiente" y la cuenta nunca quedaría fullyPaid.
   */
  discountCents = 0,
): OrderRecompute {
  const chargeableCents = Math.max(
    0,
    subtotalCents + taxOnTopCents - discountCents,
  );
  const paidSumCents = approvedPayments.reduce(
    (s, p) => s + p.amountCents,
    0,
  );
  const tipsTotalCents = approvedPayments.reduce(
    (s, p) => s + p.tipCents,
    0,
  );
  const foodPaidCents = paidSumCents - tipsTotalCents;
  const fullyPaid = foodPaidCents >= chargeableCents;
  const outstandingCents = Math.max(0, chargeableCents - foodPaidCents);
  return {
    paidSumCents,
    tipsTotalCents,
    foodPaidCents,
    fullyPaid,
    outstandingCents,
  };
}

export type PaymentValidation =
  | { ok: true }
  | {
      ok: false;
      reason: "order_already_paid" | "amount_exceeds_outstanding";
      outstandingCents: number;
    };

/**
 * Defense-in-depth check that runs server-side before accepting a new
 * payment. Catches three classes of race / client-bug:
 *
 *   - The order is already paid and someone tries to over-collect (e.g.
 *     two devices both call /pay with a partial amount that overlaps).
 *   - The client did the wrong math (the famous "partes iguales over
 *     the original subtotal" bug) and tries to charge more than what's
 *     left on the bill.
 *   - Cash settles and tarjeta charges interleave in a way the client
 *     can't possibly know about ahead of time.
 *
 * Includes pending demo_cash payments in the outstanding calc — those
 * are mesero-pending but already represent claimed money. Without this
 * a diner could swipe cash at the table and the cashier could
 * simultaneously charge by card the same amount.
 *
 * Pass the FOOD-only portion of the new payment (amountCents minus the
 * tip you'd record). Tips are always allowed on top — they don't count
 * against the outstanding balance.
 */
export async function validateNewPaymentAmount(
  orderId: string,
  newFoodCents: number,
  // Opciones de exclusión cuando el caller va a barrer pendings
  // viejos en la misma transacción (sino el cap rechazaría el cobro
  // legítimo porque el pending stale reclama outstanding).
  //
  //   excludePending=true → ignora TODOS los pendings (caso cash
  //     settleNow: el operator sweepa todos los demo_cash en la tx)
  //   excludePendingMethods=[...] → ignora pendings sólo de esos
  //     métodos (caso terminal: el diner retoca el botón, queremos
  //     sweep de pendings del MISMO método sin tocar otros)
  opts: {
    excludePending?: boolean;
    excludePendingMethods?: PaymentMethod[];
  } = {},
): Promise<PaymentValidation> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: {
      subtotalCents: true,
      taxCents: true,
      discountCents: true,
      status: true,
    },
  });
  if (!order) {
    return { ok: false, reason: "order_already_paid", outstandingCents: 0 };
  }
  if (order.status === "paid") {
    return { ok: false, reason: "order_already_paid", outstandingCents: 0 };
  }
  // By default count approved AND pending(cash) payments — a pending
  // demo_cash payment is money the diner has already "claimed" they
  // will hand to the mesero. Letting another payment slip in on top
  // would double-collect when the cash arrives. excludePending lifts
  // that constraint completamente; excludePendingMethods lo hace por
  // método (más fino para flows que sólo sweepan su propio método).
  const where: Prisma.PaymentWhereInput = (() => {
    if (opts.excludePending) {
      return { orderId, status: "approved" };
    }
    if (opts.excludePendingMethods?.length) {
      return {
        orderId,
        OR: [
          { status: "approved" },
          {
            status: "pending",
            method: { notIn: opts.excludePendingMethods },
          },
        ],
      };
    }
    return {
      orderId,
      status: { in: ["approved", "pending"] },
    };
  })();
  const claims = await db.payment.findMany({
    where,
    select: { amountCents: true, tipCents: true },
  });
  const totals = computeOrderTotals(
    order.subtotalCents,
    claims,
    order.taxCents,
    order.discountCents,
  );
  // 1 peso of slack swallows the rounding loss when partes-iguales
  // splits an odd number of pesos across N people.
  const SLACK = 1;
  if (newFoodCents > totals.outstandingCents + SLACK) {
    return {
      ok: false,
      reason: "amount_exceeds_outstanding",
      outstandingCents: totals.outstandingCents,
    };
  }
  return { ok: true };
}

/**
 * Inside a Prisma transaction: re-read approved payments, recompute totals,
 * and update the order's tipCents/totalCents/status/paidAt accordingly.
 *
 * Returns the recompute summary so the caller can decide whether to publish
 * `order.paid` vs `order.updated` and whether to release open rounds.
 */
export async function recomputeOrderTotalsInTx(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<OrderRecompute> {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: {
      subtotalCents: true,
      taxCents: true,
      discountCents: true,
      paidAt: true,
    },
  });
  if (!order) throw new Error(`order ${orderId} vanished`);
  const approved = await tx.payment.findMany({
    where: { orderId, status: "approved" },
    select: { amountCents: true, tipCents: true },
  });
  const totals = computeOrderTotals(
    order.subtotalCents,
    approved,
    order.taxCents,
    order.discountCents,
  );
  const now = new Date();
  await tx.order.update({
    where: { id: orderId },
    data: {
      tipCents: totals.tipsTotalCents,
      // Misma fórmula que chargeableCents en computeOrderTotals, o el total
      // persistido y el que decide "cuenta saldada" se irían separando:
      // + taxCents  → lo que las líneas libres suman encima también se cobra
      // − discountCents → el descuento del comensal baja lo cobrable
      totalCents:
        Math.max(
          0,
          order.subtotalCents + order.taxCents - order.discountCents,
        ) + totals.tipsTotalCents,
      status: totals.fullyPaid ? "paid" : "paying",
      paidAt: totals.fullyPaid ? (order.paidAt ?? now) : null,
    },
  });
  return totals;
}

/**
 * Defensive sync: re-derive the order's subtotal from its currently-live
 * (non-cancelled) items. If the stored value drifted (e.g. a round was
 * cancelled before the recompute fix shipped, or a future bug skipped the
 * update), this brings the row back in line on read.
 *
 * Returns the canonical subtotal so callers can use it without a follow-up
 * fetch. Idempotent — if values already match, no write happens. Skips paid
 * orders so we never re-touch a closed bill.
 */
export async function syncOrderSubtotalFromLiveItems(
  orderId: string,
): Promise<{ subtotalCents: number; totalCents: number; changed: boolean }> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      status: true,
      subtotalCents: true,
      taxCents: true,
      tipCents: true,
      totalCents: true,
      discountPct: true,
      discountCents: true,
    },
  });
  if (!order) {
    return { subtotalCents: 0, totalCents: 0, changed: false };
  }
  if (order.status === "paid" || order.status === "paying") {
    return {
      subtotalCents: order.subtotalCents,
      totalCents: order.totalCents,
      changed: false,
    };
  }
  // Live items = items whose round is either null (legacy) or not cancelled,
  // y que tampoco fueron cancelados individualmente desde el detail sheet
  // del mesero (cancelledAt != null).
  const items = await db.orderItem.findMany({
    where: {
      orderId,
      cancelledAt: null,
      OR: [{ roundId: null }, { round: { status: { not: "cancelled" } } }],
    },
    select: {
      qty: true,
      priceCentsSnapshot: true,
      taxKind: true,
      taxPct: true,
    },
  });
  const taxed = orderTaxTotals(
    items.map((i) => ({
      amountCents: i.priceCentsSnapshot * i.qty,
      taxKind: i.taxKind,
      taxPct: i.taxPct,
    })),
    // El tipo/tarifa del comercio sólo afecta el desglose por tipo, que acá
    // no se usa: para el total sólo cuenta lo que las líneas libres suman.
    { kind: "none", pct: 0 },
  );
  const liveSubtotal = taxed.subtotalCents;
  const liveTax = taxed.taxOnTopCents;
  // El descuento es un PORCENTAJE, así que si el subtotal cambió (otro
  // plato, una ronda cancelada) el valor en pesos tiene que seguirlo. El
  // porcentaje pactado no se toca; solo se re-deriva el monto.
  const liveDiscount = computeDiscountCents(liveSubtotal, order.discountPct);
  const liveTotal = Math.max(0, liveSubtotal - liveDiscount) + liveTax + order.tipCents;
  if (
    liveSubtotal === order.subtotalCents &&
    liveTax === order.taxCents &&
    liveDiscount === order.discountCents &&
    liveTotal === order.totalCents
  ) {
    return {
      subtotalCents: order.subtotalCents,
      totalCents: order.totalCents,
      changed: false,
    };
  }
  await db.order.update({
    where: { id: orderId },
    data: {
      subtotalCents: liveSubtotal,
      taxCents: liveTax,
      discountCents: liveDiscount,
      totalCents: liveTotal,
    },
  });
  return { subtotalCents: liveSubtotal, totalCents: liveTotal, changed: true };
}
