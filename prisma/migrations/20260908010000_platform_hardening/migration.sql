-- AlterTable
ALTER TABLE "User" ADD COLUMN     "sessionVersion" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "reconciliationRequired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "refundReservedCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "requestKey" TEXT;

-- CreateTable
CREATE TABLE "PlatformEvent" (
    "id" BIGSERIAL NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "orderId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateLimitBucket" (
    "key" TEXT NOT NULL,
    "hits" INTEGER NOT NULL DEFAULT 1,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "FinancialOperation" (
    "key" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "providerRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinancialOperation_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "PlatformEvent_restaurantId_id_idx" ON "PlatformEvent"("restaurantId", "id");

-- CreateIndex
CREATE INDEX "PlatformEvent_createdAt_idx" ON "PlatformEvent"("createdAt");

-- CreateIndex
CREATE INDEX "RateLimitBucket_expiresAt_idx" ON "RateLimitBucket"("expiresAt");

-- CreateIndex
CREATE INDEX "FinancialOperation_status_createdAt_idx" ON "FinancialOperation"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_requestKey_key" ON "Payment"("requestKey");


-- Revoke existing JWTs after any change to credentials or authorization.
CREATE FUNCTION mesapay_revoke_sessions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."passwordHash", NEW.role, NEW."restaurantId", NEW."groupId", NEW."disabledAt")
     IS DISTINCT FROM ROW(OLD."passwordHash", OLD.role, OLD."restaurantId", OLD."groupId", OLD."disabledAt") THEN
    NEW."sessionVersion" := OLD."sessionVersion" + 1;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER revoke_sessions BEFORE UPDATE ON "User"
FOR EACH ROW EXECUTE FUNCTION mesapay_revoke_sessions();

-- Financial constraints apply immediately to new/updated rows, without rewriting history.
ALTER TABLE "Payment" ADD CONSTRAINT payment_amounts_valid CHECK
  ("amountCents" >= 0 AND "tipCents" >= 0 AND "tipCents" <= "amountCents"
   AND "refundedCents" >= 0 AND "refundReservedCents" >= 0
   AND "refundedCents" + "refundReservedCents" <= "amountCents") NOT VALID;

-- All insertion paths reserve the same balance under a row lock.
CREATE FUNCTION mesapay_reserve_payment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o "Order"%ROWTYPE; claimed bigint;
BEGIN
  SELECT * INTO o FROM "Order" WHERE id = NEW."orderId" FOR UPDATE;
  IF NEW.status IN ('pending', 'approved') THEN
    IF o.status = 'cancelled' THEN RAISE EXCEPTION 'order_closed' USING ERRCODE = '23514'; END IF;
    SELECT COALESCE(SUM("amountCents" - "tipCents"), 0) INTO claimed
      FROM "Payment" WHERE "orderId" = NEW."orderId" AND status IN ('pending', 'approved');
    IF claimed + NEW."amountCents" - NEW."tipCents" > GREATEST(0, o."subtotalCents"::bigint + o."taxCents" - o."discountCents") + 1 THEN
      RAISE EXCEPTION 'amount_exceeds_outstanding' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reserve_payment BEFORE INSERT ON "Payment"
FOR EACH ROW EXECUTE FUNCTION mesapay_reserve_payment();

-- Durable invalidation is committed together with the order, including blue/green.
CREATE FUNCTION mesapay_order_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "PlatformEvent" ("restaurantId", "orderId", payload)
    VALUES (NEW."restaurantId", NEW.id, jsonb_build_object('type',
      CASE WHEN NEW.status = 'paid' THEN 'order.paid' ELSE 'order.updated' END, 'orderId', NEW.id));
  RETURN NEW;
END $$;
CREATE TRIGGER order_event AFTER INSERT OR UPDATE ON "Order"
FOR EACH ROW EXECUTE FUNCTION mesapay_order_event();
