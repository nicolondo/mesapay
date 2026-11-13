-- CreateEnum
CREATE TYPE "PlatformWalletMode" AS ENUM ('sandbox', 'production');

-- CreateEnum
CREATE TYPE "PlatformPayoutStatus" AS ENUM ('submitting', 'initialized', 'approved', 'declined', 'unknown', 'failed');

-- AlterTable
ALTER TABLE "PlatformConfig" ADD COLUMN     "platformWalletAccountId" TEXT;

-- CreateTable
CREATE TABLE "PlatformWalletAccount" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "mode" "PlatformWalletMode" NOT NULL,
    "publicKey" TEXT NOT NULL,
    "privateKeyEnc" TEXT NOT NULL,
    "webhookSecretEnc" TEXT NOT NULL,
    "createdById" TEXT,
    "createdByEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformWalletAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformPayout" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "payloadFingerprint" TEXT NOT NULL,
    "amountCents" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'COP',
    "bankId" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "accountType" TEXT NOT NULL,
    "accountLast4" TEXT NOT NULL,
    "holderName" TEXT NOT NULL,
    "description" TEXT,
    "status" "PlatformPayoutStatus" NOT NULL DEFAULT 'submitting',
    "reference" TEXT NOT NULL,
    "providerRef" TEXT,
    "ticketNumber" TEXT,
    "errorCode" TEXT,
    "submissionLeaseUntil" TIMESTAMP(3) NOT NULL,
    "initStartedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdByEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "PlatformPayout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlatformPayout_idempotencyKey_key" ON "PlatformPayout"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformPayout_reference_key" ON "PlatformPayout"("reference");

-- CreateIndex
CREATE INDEX "PlatformPayout_createdAt_id_idx" ON "PlatformPayout"("createdAt", "id");

-- CreateIndex
CREATE INDEX "PlatformPayout_status_idx" ON "PlatformPayout"("status");

-- CreateIndex
CREATE INDEX "PlatformPayout_accountId_createdAt_idx" ON "PlatformPayout"("accountId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformPayout_accountId_providerRef_key" ON "PlatformPayout"("accountId", "providerRef");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformPayout_accountId_ticketNumber_key" ON "PlatformPayout"("accountId", "ticketNumber");

-- AddForeignKey
ALTER TABLE "PlatformConfig" ADD CONSTRAINT "PlatformConfig_platformWalletAccountId_fkey" FOREIGN KEY ("platformWalletAccountId") REFERENCES "PlatformWalletAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformPayout" ADD CONSTRAINT "PlatformPayout_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "PlatformWalletAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

