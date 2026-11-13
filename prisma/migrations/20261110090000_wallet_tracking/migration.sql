-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PayoutStatus" ADD VALUE 'submitting';
ALTER TYPE "PayoutStatus" ADD VALUE 'unknown';

-- AlterTable
ALTER TABLE "PlatformPayout" ADD COLUMN     "providerVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "walletAccountFingerprint" TEXT;

-- AlterTable
ALTER TABLE "MembershipPayment" ADD COLUMN     "currency" TEXT,
ADD COLUMN     "walletTrackingKey" TEXT,
ADD COLUMN     "walletTrackingMode" "PlatformWalletMode";

-- AlterTable
ALTER TABLE "BillingSubscription" ADD COLUMN     "walletTrackingKey" TEXT,
ADD COLUMN     "walletTrackingMode" "PlatformWalletMode";

-- AlterTable
ALTER TABLE "Reservation" ADD COLUMN     "depositCurrency" TEXT,
ADD COLUMN     "depositPaidAt" TIMESTAMP(3),
ADD COLUMN     "depositSourceMode" "PlatformWalletMode",
ADD COLUMN     "depositTrackingKey" TEXT;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "walletTrackingCurrency" TEXT,
ADD COLUMN     "walletTrackingKey" TEXT,
ADD COLUMN     "walletTrackingMode" "PlatformWalletMode";

-- AlterTable
ALTER TABLE "Payout" ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "initStartedAt" TIMESTAMP(3),
ADD COLUMN     "payloadFingerprint" TEXT,
ADD COLUMN     "providerVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "sourceMode" "PlatformWalletMode",
ADD COLUMN     "submissionLeaseUntil" TIMESTAMP(3),
ADD COLUMN     "walletAccountFingerprint" TEXT,
ADD COLUMN     "webhookSecretEnc" TEXT;

-- AlterTable
ALTER TABLE "PaymentLink" ADD COLUMN     "walletTrackingKey" TEXT,
ADD COLUMN     "walletTrackingMode" "PlatformWalletMode";

-- CreateTable
CREATE TABLE "WalletTrackingAccount" (
    "id" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "scopeKind" TEXT NOT NULL,
    "restaurantId" TEXT,
    "trackingKey" TEXT NOT NULL,
    "walletAccountFingerprint" TEXT NOT NULL,
    "platformWalletAccountId" TEXT,
    "mode" "PlatformWalletMode" NOT NULL,
    "currency" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "baselineAvailableCents" BIGINT NOT NULL,
    "openingPendingCents" BIGINT NOT NULL DEFAULT 0,
    "excludesEarlier" BOOLEAN NOT NULL DEFAULT true,
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "nextCheckAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSuccessAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WalletTrackingAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletTrackingEntry" (
    "id" BIGSERIAL NOT NULL,
    "accountId" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "operationKey" TEXT,
    "sourceKind" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amountCents" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "sourceAmountCents" BIGINT NOT NULL DEFAULT 0,
    "sourceRefundedCents" BIGINT NOT NULL DEFAULT 0,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dateBasis" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "actorId" TEXT,
    "actorEmail" TEXT,
    "reason" TEXT,

    CONSTRAINT "WalletTrackingEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletBalanceSnapshot" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "runKey" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "providerBalanceDate" TIMESTAMP(3),
    "availableCents" BIGINT NOT NULL,
    "ledgerWatermark" BIGINT NOT NULL,
    "chargesCents" BIGINT NOT NULL,
    "refundsCents" BIGINT NOT NULL,
    "registeredFeesCents" BIGINT NOT NULL,
    "effectiveOutgoingCents" BIGINT NOT NULL,
    "adjustmentsCents" BIGINT NOT NULL,
    "incorporatedHistoryCents" BIGINT NOT NULL,
    "signedDifferenceCents" BIGINT,
    "status" TEXT NOT NULL,
    "ambiguousOutgoingCount" INTEGER NOT NULL DEFAULT 0,
    "excludedSourceCount" INTEGER NOT NULL DEFAULT 0,
    "historicalChangeToken" TEXT,
    "reasons" TEXT[],
    "algorithmVersion" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "WalletBalanceSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletTrackingJob" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "restaurantCursor" TEXT,
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WalletTrackingJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WalletTrackingAccount_trackingKey_key" ON "WalletTrackingAccount"("trackingKey");

-- CreateIndex
CREATE INDEX "WalletTrackingAccount_scopeKey_active_createdAt_idx" ON "WalletTrackingAccount"("scopeKey", "active", "createdAt");

-- CreateIndex
CREATE INDEX "WalletTrackingAccount_active_nextCheckAt_idx" ON "WalletTrackingAccount"("active", "nextCheckAt");

-- CreateIndex
CREATE UNIQUE INDEX "WalletTrackingEntry_sourceKey_key" ON "WalletTrackingEntry"("sourceKey");

-- CreateIndex
CREATE UNIQUE INDEX "WalletTrackingEntry_operationKey_key" ON "WalletTrackingEntry"("operationKey");

-- CreateIndex
CREATE INDEX "WalletTrackingEntry_accountId_id_idx" ON "WalletTrackingEntry"("accountId", "id");

-- CreateIndex
CREATE INDEX "WalletTrackingEntry_accountId_kind_idx" ON "WalletTrackingEntry"("accountId", "kind");

-- CreateIndex
CREATE INDEX "WalletTrackingEntry_accountId_sourceKind_sourceId_idx" ON "WalletTrackingEntry"("accountId", "sourceKind", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "WalletBalanceSnapshot_runKey_key" ON "WalletBalanceSnapshot"("runKey");

-- CreateIndex
CREATE INDEX "WalletBalanceSnapshot_accountId_observedAt_idx" ON "WalletBalanceSnapshot"("accountId", "observedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_idempotencyKey_key" ON "Payout"("idempotencyKey");

-- AddForeignKey
ALTER TABLE "WalletTrackingAccount" ADD CONSTRAINT "WalletTrackingAccount_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletTrackingEntry" ADD CONSTRAINT "WalletTrackingEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WalletTrackingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletBalanceSnapshot" ADD CONSTRAINT "WalletBalanceSnapshot_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WalletTrackingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
