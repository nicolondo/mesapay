ALTER TABLE "Order" ADD COLUMN "stockConsumptionAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "stockConsumptionRetryAt" TIMESTAMP(3);
CREATE INDEX stock_consumption_pending ON "Order" ("stockConsumptionRetryAt", "paidAt")
WHERE status = 'paid' AND "stockConsumedAt" IS NULL;
