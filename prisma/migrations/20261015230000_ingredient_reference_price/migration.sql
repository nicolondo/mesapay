-- A reference price does not change existing stock valuation or purchase history.
ALTER TABLE "Ingredient" ADD COLUMN "referencePriceCents" INTEGER;

ALTER TABLE "Ingredient" ADD CONSTRAINT "Ingredient_referencePriceCents_range"
  CHECK ("referencePriceCents" IS NULL OR "referencePriceCents" BETWEEN 0 AND 2000000000);
