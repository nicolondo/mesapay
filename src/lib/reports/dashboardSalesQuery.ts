import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import type { RestaurantTax } from "@/lib/salesTax";
import {
  DASHBOARD_OPEN_ORDER_STATUSES,
  dashboardOrderNetSalesCents,
  dashboardOrderUncollectedNetCents,
  summarizeDashboardUncollected,
  type DashboardSale,
} from "./dashboardSales";

/**
 * Menu lines whose embedded tax is split out: free lines carry their own tax
 * on top, and cancelled or comped items and cancelled rounds never sell.
 */
const LIVE_MENU_LINES = {
  taxKind: null, cancelledAt: null, qty: { gt: 0 },
  OR: [{ roundId: null }, { round: { status: { not: "cancelled" } } }],
} satisfies Prisma.OrderItemWhereInput;

/** Without a positive merchant tax there is no embedded menu tax to split. */
function embedsMenuTax(tax: RestaurantTax): boolean {
  return tax.kind !== "none" && tax.pct > 0;
}

type PaidOrder = {
  id: string;
  paidAt: Date;
  totalCents: number;
  tipCents: number;
  taxCents: number;
  invoiceId: string | null;
  salesTaxKind: string | null;
  embeddedTaxCents: unknown;
};

/**
 * Read-only sales projection for the operator dashboard. Do not fetch full
 * invoice JSON: it contains customer data and every invoice line, while the
 * dashboard needs just two tax fields. JSON tax remains uncast so malformed
 * legacy values cannot make PostgreSQL fail the whole report.
 */
export async function loadDashboardSales(
  restaurantId: string,
  range: { from: Date; to: Date },
  currentTax: RestaurantTax,
): Promise<DashboardSale[]> {
  const orders = await db.$queryRaw<PaidOrder[]>(Prisma.sql`
    SELECT o."id", o."paidAt", o."totalCents", o."tipCents", o."taxCents",
      i."id" AS "invoiceId",
      i."snapshot" ->> 'salesTaxKind' AS "salesTaxKind",
      i."snapshot" -> 'embeddedTaxCents' AS "embeddedTaxCents"
    FROM "Order" o
    LEFT JOIN "SimpleInvoice" i ON i."orderId" = o."id"
      AND i."restaurantId" = o."restaurantId"
    WHERE o."restaurantId" = ${restaurantId}
      AND o."status" = 'paid'
      AND o."paidAt" >= ${range.from} AND o."paidAt" < ${range.to}
  `);
  const uninvoicedIds = embedsMenuTax(currentTax)
    ? orders.filter((order) => order.invoiceId === null && order.totalCents > order.tipCents + order.taxCents)
      .map((order) => order.id)
    : [];
  const menuItems = uninvoicedIds.length > 0
    ? await db.orderItem.findMany({
      where: { orderId: { in: uninvoicedIds }, order: { restaurantId }, ...LIVE_MENU_LINES },
      select: { orderId: true, priceCentsSnapshot: true, qty: true },
    })
    : [];
  const itemsByOrder = Object.groupBy(menuItems, (item) => item.orderId);
  return orders.map((order) => ({
    paidAt: order.paidAt,
    netCents: dashboardOrderNetSalesCents({
      totalCents: order.totalCents, tipCents: order.tipCents, taxCents: order.taxCents,
      invoice: order.invoiceId === null
        ? null
        : { salesTaxKind: order.salesTaxKind, embeddedTaxCents: order.embeddedTaxCents },
      menuItems: itemsByOrder[order.id] ?? [],
    }, currentTax),
  }));
}

/**
 * «Por cobrar» on the dashboard: the unpaid part of the accounts still open
 * that were opened since `openedSince`, the start of the current business
 * day. An account left open from an earlier business day is not added: it is
 * a forgotten or walked-out bill to settle from Mesas, not today's service, and
 * would otherwise inflate the figure day after day. It still counts in
 * «Abiertas ahora».
 */
export async function loadDashboardUncollected(
  restaurantId: string,
  openedSince: Date,
  currentTax: RestaurantTax,
): Promise<{ netCents: number; orderCount: number }> {
  const orders = await db.order.findMany({
    where: {
      restaurantId,
      status: { in: DASHBOARD_OPEN_ORDER_STATUSES },
      createdAt: { gte: openedSince },
    },
    select: {
      id: true, subtotalCents: true, taxCents: true, discountCents: true,
      payments: { where: { status: "approved" }, select: { amountCents: true, tipCents: true } },
    },
  });
  const taxedIds = embedsMenuTax(currentTax)
    ? orders.filter((order) => order.subtotalCents > 0).map((order) => order.id)
    : [];
  const menuItems = taxedIds.length > 0
    ? await db.orderItem.findMany({
      where: { orderId: { in: taxedIds }, order: { restaurantId }, ...LIVE_MENU_LINES },
      select: { orderId: true, priceCentsSnapshot: true, qty: true },
    })
    : [];
  const itemsByOrder = Object.groupBy(menuItems, (item) => item.orderId);
  return summarizeDashboardUncollected(orders.map((order) => dashboardOrderUncollectedNetCents({
    subtotalCents: order.subtotalCents,
    taxCents: order.taxCents,
    discountCents: order.discountCents,
    approvedPayments: order.payments,
    menuItems: itemsByOrder[order.id] ?? [],
  }, currentTax)));
}
