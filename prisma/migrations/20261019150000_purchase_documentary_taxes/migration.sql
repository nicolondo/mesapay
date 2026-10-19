-- Nullable VAT retains the legacy percentage calculation. No historical
-- invoices or immutable stock movements are recalculated by this migration.
ALTER TABLE "PurchaseOrderItem"
  ADD COLUMN "expectedTaxCents" INTEGER,
  ADD COLUMN "expectedIncCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "nonInventoryReceivedIncCents" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "PurchaseOrderItem"
  ADD CONSTRAINT "PurchaseOrderItem_expectedTaxCents_valid"
    CHECK ("expectedTaxCents" IS NULL OR
      ("expectedTaxCents" BETWEEN 0 AND 2000000000 AND
       ("expectedTaxCents" = 0 OR "expectedCostCents" > 0))),
  ADD CONSTRAINT "PurchaseOrderItem_expectedIncCents_valid"
    CHECK ("expectedIncCents" BETWEEN 0 AND 2000000000),
  ADD CONSTRAINT "PurchaseOrderItem_nonInventoryReceivedIncCents_valid"
    CHECK ("nonInventoryReceivedIncCents" >= 0);
