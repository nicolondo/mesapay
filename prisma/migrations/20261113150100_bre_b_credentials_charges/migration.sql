-- Bre-B vía Kushki: credenciales del comercio Bre-B por restaurante y el
-- registro de cada intento de cobro (QR).
--
-- Aditivo y nullable: ningún comercio existente cambia. El medio
-- `kushki_bre_b` queda APAGADO por defecto (no entra en el "todos
-- habilitados" de `enabledPaymentMethods = NULL`; ver
-- src/lib/paymentMethods.ts) y no se puede habilitar sin estas llaves.

-- AlterTable: llaves del comercio Bre-B (distinto del de tarjeta/PSE). La
-- privada y la firma del webhook se guardan cifradas (AES-256-GCM), igual
-- que "kushkiPrivateKeyEnc".
ALTER TABLE "Restaurant" ADD COLUMN     "kushkiBreBMerchantId" TEXT,
ADD COLUMN     "kushkiBreBMerchantName" TEXT,
ADD COLUMN     "kushkiBreBPublicKey" TEXT,
ADD COLUMN     "kushkiBreBPrivateKeyEnc" TEXT,
ADD COLUMN     "kushkiBreBWebhookSecretEnc" TEXT;

-- CreateTable
CREATE TABLE "BreBCharge" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "paymentId" TEXT,
    "paymentLinkId" TEXT,
    "mode" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'COP',
    "status" TEXT NOT NULL DEFAULT 'creating',
    "token" TEXT,
    "transactionReference" TEXT,
    "ticketNumber" TEXT,
    "processorName" TEXT,
    "qrImage" TEXT,
    "expiresAt" TIMESTAMP(3),
    "cancelRequestedAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "canceledAt" TIMESTAMP(3),
    "checkedAt" TIMESTAMP(3),
    "checkStatus" TEXT,
    "failureCode" TEXT,
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BreBCharge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BreBCharge_paymentId_key" ON "BreBCharge"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "BreBCharge_token_key" ON "BreBCharge"("token");

-- CreateIndex
CREATE INDEX "BreBCharge_restaurantId_status_idx" ON "BreBCharge"("restaurantId", "status");

-- CreateIndex
CREATE INDEX "BreBCharge_status_expiresAt_idx" ON "BreBCharge"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "BreBCharge_paymentLinkId_idx" ON "BreBCharge"("paymentLinkId");

-- CreateIndex
CREATE INDEX "BreBCharge_transactionReference_idx" ON "BreBCharge"("transactionReference");

-- AddForeignKey
ALTER TABLE "BreBCharge" ADD CONSTRAINT "BreBCharge_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BreBCharge" ADD CONSTRAINT "BreBCharge_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BreBCharge" ADD CONSTRAINT "BreBCharge_paymentLinkId_fkey" FOREIGN KEY ("paymentLinkId") REFERENCES "PaymentLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;
