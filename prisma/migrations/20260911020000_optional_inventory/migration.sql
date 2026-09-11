ALTER TABLE "Ingredient" ADD COLUMN "trackInventory" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "MenuItem" ADD COLUMN "trackInventory" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "ProductionBatch" ADD COLUMN "partialCost" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PurchaseOrderItem" ADD COLUMN "nonInventoryReceivedCostCents" INTEGER NOT NULL DEFAULT 0;
