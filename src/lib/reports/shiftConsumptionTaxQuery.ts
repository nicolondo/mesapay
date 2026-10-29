import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  allocateShiftConsumptionTax,
  sumShiftConsumptionTax,
  type ConsumptionTaxSummary,
  type FrozenTaxInvoice,
} from "./shiftConsumptionTax";

type SelectedPayment = { id: string; orderId: string };
type InvoiceProjection = FrozenTaxInvoice & { orderId: string };

/**
 * Two batched, tenant-scoped reads for every selected order. Only fiscal JSON
 * fields leave PostgreSQL; customer details and invoice lines are not fetched.
 * JSON values stay uncast so a malformed legacy amount cannot crash a close.
 */
export async function loadShiftConsumptionTax(
  restaurantId: string,
  selectedPayments: readonly SelectedPayment[],
): Promise<Map<string, ConsumptionTaxSummary>> {
  const selected = new Map(selectedPayments.map((p) => [p.id, { consumptionTaxCents: 0, taxPendingPayments: 1 }]));
  const orderIds = [...new Set(selectedPayments.map((p) => p.orderId))];
  if (!orderIds.length) return selected;
  const [payments, invoices] = await Promise.all([
    db.payment.findMany({
      where: { orderId: { in: orderIds }, order: { restaurantId }, status: { in: ["approved", "refunded"] } },
      select: { id: true, orderId: true, amountCents: true, tipCents: true, settledAt: true, createdAt: true },
    }),
    db.$queryRaw<InvoiceProjection[]>(Prisma.sql`
      SELECT i."orderId", i."totalCents",
        (SELECT COALESCE(jsonb_object_agg(field.key, field.value), '{}'::jsonb)
          FROM jsonb_each(CASE WHEN jsonb_typeof(i."snapshot") = 'object'
            THEN i."snapshot" ELSE '{}'::jsonb END) AS field
          WHERE field.key IN ('totalCents', 'tipCents', 'taxCents', 'taxByKind',
            'salesTaxKind', 'embeddedTaxCents')) AS "fiscal"
      FROM "SimpleInvoice" i
      JOIN "Order" o ON o."id" = i."orderId" AND o."restaurantId" = i."restaurantId"
      WHERE i."restaurantId" = ${restaurantId} AND i."orderId" IN (${Prisma.join(orderIds)})
    `),
  ]);
  const byOrder = Object.groupBy(payments, (p) => p.orderId);
  const invoiceByOrder = new Map(invoices.map((i) => [i.orderId, i]));
  for (const orderId of orderIds) {
    const allocations = allocateShiftConsumptionTax(invoiceByOrder.get(orderId) ?? null, byOrder[orderId] ?? []);
    for (const [paymentId, amount] of allocations) {
      if (selected.has(paymentId)) selected.set(paymentId, amount);
    }
  }
  return selected;
}

type ShiftWindow = { id: string; userId: string | null; openedAt: Date; closedAt: Date | null };
type ShiftPaymentSummary = ConsumptionTaxSummary & { grossCents: number; tipCents: number; paymentCount: number };

/** Shared by both histories: one payment selection for all personal/global windows. */
export async function loadShiftPaymentSummaries(
  restaurantId: string,
  shifts: readonly ShiftWindow[],
): Promise<Map<string, ShiftPaymentSummary>> {
  if (!shifts.length) return new Map();
  const globalIds = shifts.filter((s) => s.userId === null).map((s) => s.id);
  const windows: Prisma.PaymentWhereInput[] = shifts.filter((s) => s.userId !== null).map((s) => ({
    collectedByUserId: s.userId,
    settledAt: { gte: s.openedAt, ...(s.closedAt ? { lte: s.closedAt } : {}) },
  }));
  if (globalIds.length) windows.push({ shiftId: { in: globalIds } });
  const payments = await db.payment.findMany({
    where: { order: { restaurantId }, status: "approved", OR: windows },
    select: { id: true, orderId: true, shiftId: true, collectedByUserId: true, settledAt: true, amountCents: true, tipCents: true },
  });
  const tax = await loadShiftConsumptionTax(restaurantId, payments);
  return new Map(shifts.map((s) => {
    const selected = payments.filter((p) => s.userId === null ? p.shiftId === s.id
      : p.collectedByUserId === s.userId && p.settledAt !== null
        && p.settledAt >= s.openedAt && (!s.closedAt || p.settledAt <= s.closedAt));
    return [s.id, {
      grossCents: selected.reduce((sum, p) => sum + p.amountCents, 0),
      tipCents: selected.reduce((sum, p) => sum + p.tipCents, 0),
      paymentCount: selected.length,
      ...sumShiftConsumptionTax(tax, selected.map((p) => p.id)),
    }];
  }));
}
