import "server-only";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { purchaseCostFromAggregate, type PurchaseCostAggregate, type PurchaseCostDTO } from "./purchaseCost";

/** The same parameterized query is available to read-only diagnostics. */
export function purchaseCostQuery(
  restaurantId: string,
  ingredientIds?: readonly string[],
): Prisma.Sql {
  const ingredientFilter = ingredientIds === undefined
    ? Prisma.empty
    : ingredientIds.length > 0
      ? Prisma.sql`AND i.id IN (${Prisma.join([...ingredientIds])})`
      : Prisma.sql`AND false`;
  return Prisma.sql`
    WITH line_groups AS (
      SELECT i.id AS "ingredientId", po.id AS "purchaseOrderId",
        po.number AS "purchaseOrderNumber", s.name AS "supplierName",
        po.status::text AS status, po."createdAt", po."receivedAt" AS "orderReceivedAt",
        MAX(pi."lastReceivedAt") AS "lastReceivedAt",
        SUM(pi."receivedQtyBase")::bigint AS "qtyBase",
        SUM(pi."receivedCostCents")::bigint AS "netCents",
        SUM(pi."nonInventoryReceivedCostCents")::bigint AS "nonInventoryNetCents",
        SUM(pi."nonInventoryReceivedNonDeductibleTaxCents")::bigint AS "nonInventoryVatCents",
        SUM(pi."nonInventoryReceivedIncCents")::bigint AS "nonInventoryIncCents",
        BOOL_OR(pi."receivedQtyBase" <= 0 OR pi."receivedCostCents" < 0
          OR pi."nonInventoryReceivedCostCents" < 0
          OR pi."nonInventoryReceivedCostCents" > pi."receivedCostCents"
          OR pi."nonInventoryReceivedNonDeductibleTaxCents" < 0
          OR pi."nonInventoryReceivedIncCents" < 0) AS "invalidLines"
      FROM "PurchaseOrder" po
      JOIN "Supplier" s ON s.id = po."supplierId" AND s."restaurantId" = ${restaurantId}
      JOIN "PurchaseOrderItem" pi ON pi."purchaseOrderId" = po.id
      JOIN "Ingredient" i ON i.id = pi."ingredientId" AND i."restaurantId" = ${restaurantId}
      WHERE po."restaurantId" = ${restaurantId}
        AND po.status IN ('received', 'partially_received')
        AND (pi."receivedQtyBase" <> 0 OR pi."receivedCostCents" <> 0
          OR pi."nonInventoryReceivedCostCents" <> 0
          OR pi."nonInventoryReceivedNonDeductibleTaxCents" <> 0
          OR pi."nonInventoryReceivedIncCents" <> 0 OR pi."lastReceivedAt" IS NOT NULL)
        ${ingredientFilter}
      GROUP BY i.id, po.id, po.number, s.name, po.status, po."createdAt", po."receivedAt"
    ), movements AS (
      SELECT g."purchaseOrderId", g."ingredientId",
        SUM(m."qtyBase")::bigint AS "movementQtyBase",
        SUM(m."valueCents")::bigint AS "movementValueCents",
        MAX(m."createdAt") AS "movementReceivedAt",
        BOOL_OR(m."qtyBase" <= 0 OR m."valueCents" < 0) AS "invalidMovements"
      FROM line_groups g
      JOIN "StockMovement" m ON m."purchaseOrderId" = g."purchaseOrderId"
        AND m."ingredientId" = g."ingredientId" AND m."restaurantId" = ${restaurantId}
        AND m.kind = 'purchase_in'
      GROUP BY g."purchaseOrderId", g."ingredientId"
    ), candidates AS (
      SELECT g.*, COALESCE(m."movementQtyBase", 0)::bigint AS "movementQtyBase",
        COALESCE(m."movementValueCents", 0)::bigint AS "movementValueCents",
        m."movementReceivedAt", COALESCE(m."invalidMovements", false) AS "invalidMovements",
        ROW_NUMBER() OVER (PARTITION BY g."ingredientId" ORDER BY
          COALESCE(g."lastReceivedAt",
            CASE WHEN g.status = 'received' THEN g."orderReceivedAt" END,
            CASE WHEN m."movementQtyBase" = g."qtyBase" THEN m."movementReceivedAt" END,
            g."createdAt") DESC,
          g."createdAt" DESC, g."purchaseOrderNumber" DESC, g."purchaseOrderId" DESC) AS ranking
      FROM line_groups g
      LEFT JOIN movements m ON m."purchaseOrderId" = g."purchaseOrderId"
        AND m."ingredientId" = g."ingredientId"
    )
    SELECT * FROM candidates WHERE ranking = 1
  `;
}

/** One read for the tenant; one candidate per ingredient. Do not silently use
 * an older cheap purchase if the latest evidence is invalid. */
export async function loadPurchaseCosts(
  restaurantId: string,
  ingredientIds?: readonly string[],
): Promise<Map<string, PurchaseCostDTO>> {
  if (ingredientIds?.length === 0) return new Map();
  const rows = await db.$queryRaw<PurchaseCostAggregate[]>(purchaseCostQuery(restaurantId, ingredientIds));
  const result = new Map<string, PurchaseCostDTO>();
  for (const row of rows) {
    const cost = purchaseCostFromAggregate(row);
    if (cost) result.set(row.ingredientId, cost);
  }
  return result;
}
