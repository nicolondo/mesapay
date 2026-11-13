import type { OrderStatus } from "@prisma/client";
import { splitTaxIncludedCents } from "@/lib/dian/ubl";
import { computeOrderTotals } from "@/lib/orderTotals";
import type { RestaurantTax } from "@/lib/salesTax";

/**
 * Accounts that are still running on the dashboard: «Abiertas ahora», the
 * active list and the amount still to collect. "open" stays out on purpose:
 * it is a counter-mode cart that was never paid (or a just-created manual
 * invoice without lines), not a bill being served.
 */
export const DASHBOARD_OPEN_ORDER_STATUSES = [
  "placed", "in_kitchen", "ready", "served", "paying",
] satisfies OrderStatus[];

export type DashboardMenuLine = { priceCentsSnapshot: number; qty: number };

export type DashboardSalesOrder = {
  totalCents: number;
  tipCents: number;
  /** Only the tax added on top of free lines; menu tax is already embedded. */
  taxCents: number;
  /** Null means no invoice. An existing legacy invoice must never use today's tax. */
  invoice: { salesTaxKind?: unknown; embeddedTaxCents?: unknown } | null;
  /** Live menu lines only, excluding cancelled items/rounds and own-tax free lines. */
  menuItems: readonly DashboardMenuLine[];
};

export type DashboardSale = { paidAt: Date; netCents: number };

/**
 * Paid sales before tips and both kinds of tax, keeping the discount already
 * reflected in totalCents. This is a sales metric, not cash received or a
 * fiscal refund ledger; credit notes/refunds keep their existing reports.
 *
 * Issued invoices keep their frozen tax (legacy/missing tax means zero).
 * Uninvoiced sales use the current merchant tax, split per live menu line
 * with exactly the same rounding as the invoice. Frozen tax is intentionally
 * not recalculated here: doing so would contradict the document. Invoices
 * that declare the customer discount inside their lines (`discountInLines`)
 * already froze the tax net of it; older ones keep the list-price tax they
 * declared.
 */
export function dashboardOrderNetSalesCents(
  order: DashboardSalesOrder,
  currentTax: RestaurantTax,
): number {
  const frozenTax = order.invoice?.embeddedTaxCents;
  const frozenKind = order.invoice?.salesTaxKind;
  const embeddedTaxCents = order.invoice !== null
    ? ((frozenKind === "inc" || frozenKind === "iva") &&
        typeof frozenTax === "number" && Number.isSafeInteger(frozenTax) && frozenTax >= 0
      ? frozenTax
      : 0)
    : currentTax.kind !== "none" && currentTax.pct > 0
      ? order.menuItems.reduce((sum, item) => sum + splitTaxIncludedCents(
        item.priceCentsSnapshot * item.qty,
        currentTax.pct * 100,
      ).taxCents, 0)
      : 0;
  return Math.max(0, order.totalCents - order.tipCents - order.taxCents - embeddedTaxCents);
}

export type DashboardOpenOrder = {
  subtotalCents: number;
  /** Tax that free lines add on top (Order.taxCents); menu tax is embedded. */
  taxCents: number;
  discountCents: number;
  /** Approved payments only: a pending cash or card-terminal request is still to collect. */
  approvedPayments: readonly { amountCents: number; tipCents: number }[];
  /** Live menu lines only, excluding cancelled/comped items and rounds and own-tax free lines. */
  menuItems: readonly DashboardMenuLine[];
};

/**
 * What is still to collect on an open order, on the same basis as «Ventas
 * hoy»: before tips and both kinds of tax, after the diner discount.
 *
 * «Ventas hoy» counts an order only once it is fully paid (by `paidAt`), and
 * then counts it whole. An open order is never in it, so there is nothing to
 * double count; what a partially paid order already received (split bill,
 * reservation deposit, voucher) is left out here because it is no longer to
 * collect, and it reaches «Ventas hoy» with the rest of the bill when it closes.
 *
 * The outstanding balance comes from `computeOrderTotals`, the same rule
 * that decides when the bill is settled (tips never reduce it). Its share of
 * net sales is proportional: payments carry tax, so the unpaid part carries
 * its share of the tax as well.
 */
export function dashboardOrderUncollectedNetCents(
  order: DashboardOpenOrder,
  currentTax: RestaurantTax,
): number {
  const { outstandingCents } = computeOrderTotals(
    order.subtotalCents,
    [...order.approvedPayments],
    order.taxCents,
    order.discountCents,
  );
  if (outstandingCents === 0) return 0;
  const chargeableCents = Math.max(0, order.subtotalCents + order.taxCents - order.discountCents);
  // Once paid, the order is stored with totalCents = chargeable + tips; this
  // is exactly the value «Ventas hoy» will then read for it. Open orders have
  // no invoice yet (it is issued on payment), so today's tax applies.
  const netCents = dashboardOrderNetSalesCents({
    totalCents: chargeableCents,
    tipCents: 0,
    taxCents: order.taxCents,
    invoice: null,
    menuItems: order.menuItems,
  }, currentTax);
  return outstandingCents >= chargeableCents
    ? netCents
    : Math.round((netCents * outstandingCents) / chargeableCents);
}

/** Total still to collect and how many open accounts it is spread over. */
export function summarizeDashboardUncollected(netCentsByOrder: readonly number[]) {
  const pending = netCentsByOrder.filter((cents) => cents > 0);
  return {
    netCents: pending.reduce((sum, cents) => sum + cents, 0),
    orderCount: pending.length,
  };
}

/** One series drives the daily table, chart and KPI values, with no browser-local dates. */
export function summarizeDashboardSales(
  rows: readonly DashboardSale[],
  { from, days }: { from: Date; days: number },
) {
  const dayMs = 86_400_000;
  const start = from.getTime();
  const emptyDays = Array.from({ length: days }, (_, index) => ({
    date: new Date(start + index * dayMs), netCents: 0, paidCount: 0,
  }));
  const totals = rows.reduce((buckets, sale) => {
    const index = Math.floor((sale.paidAt.getTime() - start) / dayMs);
    if (!(index >= 0 && index < days)) return buckets;
    return buckets.map((bucket, i) => i === index
      ? { ...bucket, netCents: bucket.netCents + sale.netCents, paidCount: bucket.paidCount + 1 }
      : bucket);
  }, emptyDays);
  const today = totals.at(-1);
  const todayNetCents = today?.netCents ?? 0;
  const todayPaidCount = today?.paidCount ?? 0;
  return {
    days: totals,
    totalNetCents: totals.reduce((sum, day) => sum + day.netCents, 0),
    todayNetCents,
    todayPaidCount,
    avgTicketNetCents: todayPaidCount === 0 ? 0 : Math.round(todayNetCents / todayPaidCount),
  };
}
