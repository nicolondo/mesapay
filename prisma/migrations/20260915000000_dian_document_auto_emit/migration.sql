-- Emisión automática de la factura electrónica de TODAS las órdenes.
--
-- `orderId`: la orden de la que sale el documento. Con SimpleInvoice ya se
-- llega a la orden; se guarda igual por el placeholder de
-- `numbering_exhausted`: con el rango de la resolución agotado no hay número
-- válido, así que no hay tirilla, y la orden pagada tiene que quedar
-- registrada para que el barrido la facture cuando haya resolución nueva.
-- `nextAttemptAt`: antes de este instante el barrido no reintenta (backoff
-- exponencial tras error de canal; espera fija tras bloqueo de config).
-- `lastError`: por qué no salió la última vez — lo que la pantalla muestra
-- como "N facturas esperando emisión — falta X".

-- AlterTable
ALTER TABLE "DianDocument" ADD COLUMN     "orderId" TEXT,
ADD COLUMN     "nextAttemptAt" TIMESTAMP(3),
ADD COLUMN     "lastError" TEXT;

-- CreateIndex
CREATE INDEX "DianDocument_state_nextAttemptAt_idx" ON "DianDocument"("state", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "DianDocument_orderId_idx" ON "DianDocument"("orderId");

-- AddForeignKey
ALTER TABLE "DianDocument" ADD CONSTRAINT "DianDocument_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
