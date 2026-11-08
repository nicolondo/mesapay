-- Additive receipt metadata only. Historical documents and stock are untouched.
ALTER TABLE "PurchaseOrderItem" ADD COLUMN "lastReceivedAt" TIMESTAMP(3);
