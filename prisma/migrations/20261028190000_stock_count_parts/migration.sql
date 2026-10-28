-- Additive only: historical counted/preliminary totals are unchanged. Empty
-- parts are normalized from the stored total by readers and new writers.
-- Older application versions can continue writing totals during deployment.
-- On an application rollback, retain these columns to preserve scan history.
ALTER TABLE "StockCountItem"
  ADD COLUMN "countedParts" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
  ADD COLUMN "preliminaryParts" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];
