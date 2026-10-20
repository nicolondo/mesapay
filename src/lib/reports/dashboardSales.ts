import { splitTaxIncludedCents } from "@/lib/dian/ubl";
import type { RestaurantTax } from "@/lib/salesTax";

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
 * not recalculated after discounts: doing so would contradict the document.
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
