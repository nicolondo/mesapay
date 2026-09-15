-- Bonos empresariales + links de pago (módulo `vouchers`, apagado por
-- defecto). El comercio emite N bonos de valor fijo a una empresa
-- (BillingCustomer); prepago → link de pago tarjeta/PSE en el correo de
-- emisión; crédito → se cobran por corte. La parte fiscal queda pendiente
-- del contador: VoucherBatch.fiscalTreatment = 'pending' hasta decidir.
--
-- PaymentLink generaliza el cobro online de un monto por URL pública
-- (base: el depósito de reserva, que sigue intacto en Reservation.deposit*).

-- CreateEnum
CREATE TYPE "VoucherMode" AS ENUM ('prepaid', 'credit');

-- CreateEnum
CREATE TYPE "VoucherFiscalTreatment" AS ENUM ('pending', 'invoiced_on_issue', 'advance');

-- CreateEnum
CREATE TYPE "VoucherBatchStatus" AS ENUM ('issued', 'paid', 'cancelled');

-- CreateEnum
CREATE TYPE "VoucherStatus" AS ENUM ('active', 'exhausted', 'cancelled', 'expired');

-- CreateEnum
CREATE TYPE "VoucherRedemptionChannel" AS ENUM ('diner', 'staff');

-- CreateEnum
CREATE TYPE "PaymentLinkKind" AS ENUM ('voucher_batch', 'voucher_statement');

-- CreateEnum
CREATE TYPE "PaymentLinkStatus" AS ENUM ('pending', 'paid', 'cancelled');

-- CreateTable
CREATE TABLE "VoucherSettings" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "mode" "VoucherMode" NOT NULL DEFAULT 'prepaid',
    "defaultValueCents" INTEGER NOT NULL DEFAULT 0,
    "defaultExpiryDays" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VoucherSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoucherBatch" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "billingCustomerId" TEXT NOT NULL,
    "mode" "VoucherMode" NOT NULL,
    "fiscalTreatment" "VoucherFiscalTreatment" NOT NULL DEFAULT 'pending',
    "unitValueCents" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "note" TEXT,
    "status" "VoucherBatchStatus" NOT NULL DEFAULT 'issued',
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issuedByUserId" TEXT,
    "paidAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "emailSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VoucherBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Voucher" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "valueCents" INTEGER NOT NULL,
    "balanceCents" INTEGER NOT NULL,
    "status" "VoucherStatus" NOT NULL DEFAULT 'active',
    "expiresAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Voucher_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoucherRedemption" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "voucherId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "paymentId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "channel" "VoucherRedemptionChannel" NOT NULL,
    "redeemedByUserId" TEXT,
    "redeemedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoucherRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentLink" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "kind" "PaymentLinkKind" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'COP',
    "status" "PaymentLinkStatus" NOT NULL DEFAULT 'pending',
    "method" "PaymentMethod",
    "providerRef" TEXT,
    "payerEmail" TEXT,
    "paidAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "voucherBatchId" TEXT,

    CONSTRAINT "PaymentLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VoucherSettings_restaurantId_key" ON "VoucherSettings"("restaurantId");

-- CreateIndex
CREATE INDEX "VoucherBatch_restaurantId_issuedAt_idx" ON "VoucherBatch"("restaurantId", "issuedAt");

-- CreateIndex
CREATE INDEX "VoucherBatch_restaurantId_billingCustomerId_idx" ON "VoucherBatch"("restaurantId", "billingCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "Voucher_restaurantId_code_key" ON "Voucher"("restaurantId", "code");

-- CreateIndex
CREATE INDEX "Voucher_batchId_idx" ON "Voucher"("batchId");

-- CreateIndex
CREATE INDEX "Voucher_restaurantId_status_idx" ON "Voucher"("restaurantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "VoucherRedemption_paymentId_key" ON "VoucherRedemption"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "VoucherRedemption_voucherId_orderId_key" ON "VoucherRedemption"("voucherId", "orderId");

-- CreateIndex
CREATE INDEX "VoucherRedemption_restaurantId_redeemedAt_idx" ON "VoucherRedemption"("restaurantId", "redeemedAt");

-- CreateIndex
CREATE INDEX "VoucherRedemption_orderId_idx" ON "VoucherRedemption"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentLink_token_key" ON "PaymentLink"("token");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentLink_voucherBatchId_key" ON "PaymentLink"("voucherBatchId");

-- CreateIndex
CREATE INDEX "PaymentLink_restaurantId_status_idx" ON "PaymentLink"("restaurantId", "status");

-- CreateIndex
CREATE INDEX "PaymentLink_providerRef_idx" ON "PaymentLink"("providerRef");

-- AddForeignKey
ALTER TABLE "VoucherSettings" ADD CONSTRAINT "VoucherSettings_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoucherBatch" ADD CONSTRAINT "VoucherBatch_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoucherBatch" ADD CONSTRAINT "VoucherBatch_billingCustomerId_fkey" FOREIGN KEY ("billingCustomerId") REFERENCES "BillingCustomer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoucherBatch" ADD CONSTRAINT "VoucherBatch_issuedByUserId_fkey" FOREIGN KEY ("issuedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Voucher" ADD CONSTRAINT "Voucher_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Voucher" ADD CONSTRAINT "Voucher_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "VoucherBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoucherRedemption" ADD CONSTRAINT "VoucherRedemption_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoucherRedemption" ADD CONSTRAINT "VoucherRedemption_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "Voucher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoucherRedemption" ADD CONSTRAINT "VoucherRedemption_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoucherRedemption" ADD CONSTRAINT "VoucherRedemption_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoucherRedemption" ADD CONSTRAINT "VoucherRedemption_redeemedByUserId_fkey" FOREIGN KEY ("redeemedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentLink" ADD CONSTRAINT "PaymentLink_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentLink" ADD CONSTRAINT "PaymentLink_voucherBatchId_fkey" FOREIGN KEY ("voucherBatchId") REFERENCES "VoucherBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
