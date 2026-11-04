import { computeDiscountCents } from "./dinerDiscount";
import type { Prisma } from "@prisma/client";
import { lockOrder } from "./orderLock";
import { orderTaxTotals } from "./salesTax";
import { assertOrderNotInvoicedInTx } from "./orders/invoicedOrder";

export async function recomputeOrderLinesInTx(tx: Prisma.TransactionClient, orderId: string) {
  await lockOrder(tx, orderId);
  // Cinturón y tirantes: todo cambio de líneas pasa por acá. Una cuenta con
  // factura no se recalcula (ver `orders/invoicedOrder.ts`).
  await assertOrderNotInvoicedInTx(tx, orderId);
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
  const items = await tx.orderItem.findMany({ where: {
    orderId, cancelledAt: null,
    OR: [{ roundId: null }, { round: { status: { not: "cancelled" } } }],
  } });
  const totals = orderTaxTotals(items.map(i => ({ amountCents: i.priceCentsSnapshot * i.qty, taxKind: i.taxKind, taxPct: i.taxPct })), { kind: "none", pct: 0 });
  const discountCents = computeDiscountCents(totals.subtotalCents, order.discountPct);
  return tx.order.update({ where: { id: orderId }, data: {
    subtotalCents: totals.subtotalCents,
    taxCents: totals.taxOnTopCents,
    discountCents,
    totalCents: Math.max(0, totals.subtotalCents - discountCents) + totals.taxOnTopCents + order.tipCents,
  } });
}

/**
 * The amount of a closed/reserved bill cannot change while money is in flight.
 * Ni la de una cuenta ya FACTURADA (factura emitida antes de cobrar): una
 * factura numerada no cambia en silencio — ver `orders/invoicedOrder.ts`.
 */
export async function requireMutableOrderInTx(tx: Prisma.TransactionClient, orderId: string) {
  await lockOrder(tx, orderId);
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
  if (["paid", "paying", "cancelled"].includes(order.status)) throw new Error("order_closed");
  await assertOrderNotInvoicedInTx(tx, orderId);
  if (await tx.payment.count({ where: { orderId, status: { in: ["pending", "approved"] } } })) throw new Error("operation_conflict");
  return order;
}
