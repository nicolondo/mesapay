ALTER TABLE "StockCount" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "preliminaryAt" TIMESTAMP(3),
ADD COLUMN "recountStartedAt" TIMESTAMP(3),
ADD COLUMN "recountSnapshot" JSONB,
ADD COLUMN "finalReview" JSONB;
ALTER TABLE "StockCountItem" ADD COLUMN "preliminaryQty" INTEGER,
ADD COLUMN "finalExpectedQty" INTEGER;
