-- Factura manual emitida POR COBRAR + link de pago que la salda.
--
-- Aditivo y nullable (o con default): ninguna fila existente cambia y la
-- versión anterior sigue leyendo y escribiendo como siempre (blue/green).
--
--  · PaymentLink.emailRecipients / openedAt: a quién se mandó el último
--    correo (todos los destinatarios) y cuándo lo abrió el cliente.
--  · PaymentLink.creditPaymentId: el cargo a crédito que el link salda
--    (factura manual emitida por cobrar). Único: un link por cargo. Todas
--    las filas existentes quedan en NULL, así que el índice único no choca.
--  · CustomerCreditPayment.creditChargeId: abono dirigido a un cargo (se
--    aplica a ése antes que FIFO). paymentLinkId: el link que lo originó
--    (único: un link se liquida una sola vez).

-- AlterTable
ALTER TABLE "PaymentLink" ADD COLUMN     "creditPaymentId" TEXT,
ADD COLUMN     "emailRecipients" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "openedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "CustomerCreditPayment" ADD COLUMN     "creditChargeId" TEXT,
ADD COLUMN     "paymentLinkId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "PaymentLink_creditPaymentId_key" ON "PaymentLink"("creditPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerCreditPayment_paymentLinkId_key" ON "CustomerCreditPayment"("paymentLinkId");

-- CreateIndex
CREATE INDEX "CustomerCreditPayment_creditChargeId_idx" ON "CustomerCreditPayment"("creditChargeId");

-- AddForeignKey
ALTER TABLE "PaymentLink" ADD CONSTRAINT "PaymentLink_creditPaymentId_fkey" FOREIGN KEY ("creditPaymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerCreditPayment" ADD CONSTRAINT "CustomerCreditPayment_creditChargeId_fkey" FOREIGN KEY ("creditChargeId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerCreditPayment" ADD CONSTRAINT "CustomerCreditPayment_paymentLinkId_fkey" FOREIGN KEY ("paymentLinkId") REFERENCES "PaymentLink"("id") ON DELETE SET NULL ON UPDATE CASCADE;
