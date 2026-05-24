// Cierre de turno helpers.
//
// A Shift is the period from when the operator clicks "Abrir turno"
// (declaring the opening cash float) until they click "Cerrar turno"
// (declaring the physical cash counted). It pins approved payments to
// itself at close time so the historical Z-report stays consistent even
// if a payment is edited later.
//
// One restaurant has at most one open shift at a time. We enforce that
// via a unique partial index in code (Prisma doesn't model partial
// uniques) — see openShift().

import type { Payment, PaymentMethod, Shift } from "@prisma/client";
import { db } from "@/lib/db";

export type ShiftMethodBreakdown = {
  method: PaymentMethod;
  count: number;
  sumCents: number;
};

export type ShiftMetrics = {
  payments: number;
  ordersClosed: number;
  grossCents: number;
  tipCents: number;
  cashCents: number;
  byMethod: ShiftMethodBreakdown[];
};

export function isCashMethod(m: PaymentMethod): boolean {
  // demo_cash is the only "physical bills" method today. kushki_card_*
  // and demo_card never sit in the drawer.
  return m === "demo_cash";
}

export async function getCurrentShift(restaurantId: string): Promise<Shift | null> {
  return db.shift.findFirst({
    where: { restaurantId, status: "open" },
    orderBy: { openedAt: "desc" },
  });
}

export async function getRecentShifts(
  restaurantId: string,
  limit = 20,
): Promise<Shift[]> {
  return db.shift.findMany({
    where: { restaurantId, status: "closed" },
    orderBy: { closedAt: "desc" },
    take: limit,
  });
}

/**
 * Live metrics for the currently-open shift — looks at approved payments
 * that arrived since openedAt and aren't yet pinned to any shift.
 */
export async function computeOpenShiftMetrics(
  restaurantId: string,
  shift: Shift,
): Promise<ShiftMetrics> {
  const payments = await db.payment.findMany({
    where: {
      status: "approved",
      shiftId: null,
      createdAt: { gte: shift.openedAt },
      order: { restaurantId },
    },
    select: {
      method: true,
      amountCents: true,
      tipCents: true,
      orderId: true,
    },
  });
  return rollUp(payments);
}

/** Same shape as live but for a closed shift, by following the shiftId pin. */
export async function computeClosedShiftMetrics(shiftId: string): Promise<ShiftMetrics> {
  const payments = await db.payment.findMany({
    where: { shiftId, status: "approved" },
    select: {
      method: true,
      amountCents: true,
      tipCents: true,
      orderId: true,
    },
  });
  return rollUp(payments);
}

function rollUp(
  payments: Pick<Payment, "method" | "amountCents" | "tipCents" | "orderId">[],
): ShiftMetrics {
  const byMethod = new Map<PaymentMethod, { count: number; sumCents: number }>();
  const orderIds = new Set<string>();
  let gross = 0;
  let tips = 0;
  let cash = 0;
  for (const p of payments) {
    const row = byMethod.get(p.method) ?? { count: 0, sumCents: 0 };
    row.count += 1;
    row.sumCents += p.amountCents;
    byMethod.set(p.method, row);
    gross += p.amountCents;
    tips += p.tipCents;
    if (isCashMethod(p.method)) cash += p.amountCents;
    orderIds.add(p.orderId);
  }
  return {
    payments: payments.length,
    ordersClosed: orderIds.size,
    grossCents: gross,
    tipCents: tips,
    cashCents: cash,
    byMethod: Array.from(byMethod.entries())
      .map(([method, agg]) => ({ method, count: agg.count, sumCents: agg.sumCents }))
      .sort((a, b) => b.sumCents - a.sumCents),
  };
}

/**
 * Orders that are still "alive" (not paid, not cancelled). Returned so the
 * close flow can list them as a hard block — closing a shift with cuentas
 * abiertas hides revenue.
 */
export async function listOpenOrders(restaurantId: string, since: Date) {
  return db.order.findMany({
    where: {
      restaurantId,
      status: { notIn: ["paid", "cancelled"] },
      createdAt: { gte: since },
    },
    select: {
      id: true,
      shortCode: true,
      subtotalCents: true,
      totalCents: true,
      status: true,
      createdAt: true,
      table: { select: { number: true, label: true } },
    },
    orderBy: { createdAt: "asc" },
  });
}
