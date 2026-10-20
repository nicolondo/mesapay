import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import type { RestaurantTax } from "@/lib/salesTax";
import {
  dashboardOrderNetSalesCents,
  type DashboardSale,
} from "./dashboardSales";

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
  const uninvoicedIds = currentTax.kind !== "none" && currentTax.pct > 0
    ? orders.filter((order) => order.invoiceId === null && order.totalCents > order.tipCents + order.taxCents)
      .map((order) => order.id)
    : [];
  const menuItems = uninvoicedIds.length > 0
    ? await db.orderItem.findMany({
      where: {
        orderId: { in: uninvoicedIds }, order: { restaurantId },
        taxKind: null, cancelledAt: null, qty: { gt: 0 },
        OR: [{ roundId: null }, { round: { status: { not: "cancelled" } } }],
      },
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
