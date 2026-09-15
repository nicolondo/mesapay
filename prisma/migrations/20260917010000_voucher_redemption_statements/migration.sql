-- Bonos empresariales, parte B: redención como forma de pago y cortes.
--
--   PaymentMethod.voucher      → el Payment (approved) que representa el
--                                bono en la cuenta. Nunca cuenta como caja.
--   VoucherStatement           → corte de bonos usados de una empresa en un
--                                período; lo de lotes a crédito se cobra
--                                con un PaymentLink (kind voucher_statement).
--   VoucherRedemption.statementId → en qué corte entró cada uso (un uso, un
--                                corte).

-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE 'voucher';

-- CreateEnum
CREATE TYPE "VoucherStatementStatus" AS ENUM ('open', 'paid');

-- CreateTable
CREATE TABLE "VoucherStatement" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "billingCustomerId" TEXT NOT NULL,
    "periodFrom" TIMESTAMP(3) NOT NULL,
    "periodTo" TIMESTAMP(3) NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "creditCents" INTEGER NOT NULL,
    "prepaidCents" INTEGER NOT NULL,
    "redemptionCount" INTEGER NOT NULL,
    "status" "VoucherStatementStatus" NOT NULL DEFAULT 'open',
    "paidAt" TIMESTAMP(3),
    "emailSentAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VoucherStatement_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "VoucherRedemption" ADD COLUMN "statementId" TEXT;

-- AlterTable
ALTER TABLE "PaymentLink" ADD COLUMN "voucherStatementId" TEXT;

-- CreateIndex
CREATE INDEX "VoucherStatement_restaurantId_createdAt_idx" ON "VoucherStatement"("restaurantId", "createdAt");

-- CreateIndex
CREATE INDEX "VoucherStatement_restaurantId_billingCustomerId_idx" ON "VoucherStatement"("restaurantId", "billingCustomerId");

-- CreateIndex
CREATE INDEX "VoucherRedemption_statementId_idx" ON "VoucherRedemption"("statementId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentLink_voucherStatementId_key" ON "PaymentLink"("voucherStatementId");

-- AddForeignKey
ALTER TABLE "VoucherStatement" ADD CONSTRAINT "VoucherStatement_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoucherStatement" ADD CONSTRAINT "VoucherStatement_billingCustomerId_fkey" FOREIGN KEY ("billingCustomerId") REFERENCES "BillingCustomer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoucherStatement" ADD CONSTRAINT "VoucherStatement_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoucherRedemption" ADD CONSTRAINT "VoucherRedemption_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "VoucherStatement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentLink" ADD CONSTRAINT "PaymentLink_voucherStatementId_fkey" FOREIGN KEY ("voucherStatementId") REFERENCES "VoucherStatement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
