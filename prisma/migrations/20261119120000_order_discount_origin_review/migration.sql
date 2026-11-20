-- Origen del descuento de la cuenta y aviso «Revisar».
--
--   "Order"."discountBillingCustomerId" → cliente de facturación cuyo
--                                         descuento comercial puso el paso
--                                         «Cliente» del cobro (o la factura
--                                         nominativa). null = comensal,
--                                         ninguno o cuenta vieja.
--   "Order"."discountAppliedAt"         → cuándo se aplicó ese descuento.
--   "Order"."reviewAckAt"               → «Mantener» del personal ante el
--                                         aviso «Revisar» de la cuenta.
--
-- Aditivo: columnas NULL sin default (sólo metadatos, sin reescribir la
-- tabla), un índice y una FK ON DELETE SET NULL que valida sobre filas
-- todas en NULL. La versión anterior no lee ni escribe estas columnas; con
-- rollback, el descuento sigue en discountPct/discountCents como siempre.

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "discountAppliedAt" TIMESTAMP(3),
ADD COLUMN     "discountBillingCustomerId" TEXT,
ADD COLUMN     "reviewAckAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Order_discountBillingCustomerId_idx" ON "Order"("discountBillingCustomerId");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_discountBillingCustomerId_fkey" FOREIGN KEY ("discountBillingCustomerId") REFERENCES "BillingCustomer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
