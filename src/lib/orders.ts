import type { Prisma } from "@prisma/client";
import { lockOrder } from "./orderLock";
import { orderTaxTotals } from "./salesTax";

export async function recomputeOrderLinesInTx(tx: Prisma.TransactionClient, orderId: string) {
  await lockOrder(tx, orderId);
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
  const items = await tx.orderItem.findMany({ where: {
    orderId, cancelledAt: null,
    OR: [{ roundId: null }, { round: { status: { not: "cancelled" } } }],
  } });
  const totals = orderTaxTotals(items.map(i => ({ amountCents: i.priceCentsSnapshot * i.qty, taxKind: i.taxKind, taxPct: i.taxPct })), { kind: "none", pct: 0 });
  return tx.order.update({ where: { id: orderId }, data: {
    subtotalCents: totals.subtotalCents,
    taxCents: totals.taxOnTopCents,
    totalCents: totals.subtotalCents + totals.taxOnTopCents + order.tipCents,
  } });
}
