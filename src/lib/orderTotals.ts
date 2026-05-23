import type { Prisma } from "@prisma/client";
import { db } from "./db";

/**
 * Single source of truth for how an order's totals are computed from its
 * approved payments. Used by every code path that flips a payment to
 * approved (table-mode pay, cash settle, Kushki webhook, terminal callback).
 *
 * The rules:
 * - tipCents on the order = sum of tipCents across approved payments
 * - totalCents = subtotalCents + tipsTotal (taxes are computed elsewhere)
 * - fullyPaid = (sum of approved amountCents) - tipsTotal >= subtotalCents
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
): OrderRecompute {
  const paidSumCents = approvedPayments.reduce(
    (s, p) => s + p.amountCents,
    0,
  );
  const tipsTotalCents = approvedPayments.reduce(
    (s, p) => s + p.tipCents,
    0,
  );
  const foodPaidCents = paidSumCents - tipsTotalCents;
  const fullyPaid = foodPaidCents >= subtotalCents;
  const outstandingCents = Math.max(0, subtotalCents - foodPaidCents);
  return {
    paidSumCents,
    tipsTotalCents,
    foodPaidCents,
    fullyPaid,
    outstandingCents,
  };
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
    select: { subtotalCents: true, paidAt: true },
  });
  if (!order) throw new Error(`order ${orderId} vanished`);
  const approved = await tx.payment.findMany({
    where: { orderId, status: "approved" },
    select: { amountCents: true, tipCents: true },
  });
  const totals = computeOrderTotals(order.subtotalCents, approved);
  const now = new Date();
  await tx.order.update({
    where: { id: orderId },
    data: {
      tipCents: totals.tipsTotalCents,
      totalCents: order.subtotalCents + totals.tipsTotalCents,
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
      tipCents: true,
      totalCents: true,
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
  // Live items = items whose round is either null (legacy) or not cancelled.
  const items = await db.orderItem.findMany({
    where: {
      orderId,
      OR: [{ roundId: null }, { round: { status: { not: "cancelled" } } }],
    },
    select: { qty: true, priceCentsSnapshot: true },
  });
  const liveSubtotal = items.reduce(
    (s, i) => s + i.priceCentsSnapshot * i.qty,
    0,
  );
  const liveTotal = liveSubtotal + order.tipCents;
  if (
    liveSubtotal === order.subtotalCents &&
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
    data: { subtotalCents: liveSubtotal, totalCents: liveTotal },
  });
  return { subtotalCents: liveSubtotal, totalCents: liveTotal, changed: true };
}
