ALTER TABLE "OrderItem" ADD COLUMN "preparationFirstStartedAt" TIMESTAMP(3);

-- Preserve evidence from current and previously started rounds. Manual
-- invoices/free charges have technical ready flags, not cooked food.
UPDATE "OrderItem" AS item
SET "preparationFirstStartedAt" = evidence.first_started
FROM (
  SELECT i.id, COALESCE(i."preparationStartedAt", i."servedAt",
    r."kitchenStartedAt", r."readyAt", o."servedAt", o."createdAt") AS first_started
  FROM "OrderItem" i
  JOIN "Order" o ON o.id = i."orderId"
  JOIN "Table" t ON t.id = o."tableId"
  LEFT JOIN "Round" r ON r.id = i."roundId"
  WHERE i."preparationStartedAt" IS NOT NULL
    OR (i."menuItemId" IS NOT NULL AND t.kind <> 'manual' AND (
      i."kitchenStatus" <> 'placed' OR i."servedAt" IS NOT NULL
      OR r."kitchenStartedAt" IS NOT NULL OR r.status IN ('ready', 'served')
      OR o.status = 'served'
    ))
) evidence
WHERE evidence.id = item.id AND item."preparationFirstStartedAt" IS NULL;
