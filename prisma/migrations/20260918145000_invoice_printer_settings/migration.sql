-- Impresión de la factura del cliente (Configuración → Impresoras → Facturas).
--
-- "Restaurant"."invoicePrinterId": la impresora ELEGIDA para las facturas; NULL
--   = todas las activas de tipo factura (como siempre). SET NULL al borrarla.
-- "Restaurant"."invoiceAutoPrint": si la factura sale sola (al cobrar, o al
--   aceptarla la DIAN con facturación electrónica). false = sólo reimpresión.
-- "Printer"."supportsQr": la impresora entiende GS ( k (QR nativo); se prende
--   a mano tras ver el QR de prueba. Sin esto la factura lleva la URL en texto.
-- Ver src/lib/print/invoiceQueue.ts.

-- AlterTable
ALTER TABLE "Restaurant" ADD COLUMN     "invoiceAutoPrint" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "invoicePrinterId" TEXT;

-- AlterTable
ALTER TABLE "Printer" ADD COLUMN     "supportsQr" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Restaurant_invoicePrinterId_idx" ON "Restaurant"("invoicePrinterId");

-- AddForeignKey
ALTER TABLE "Restaurant" ADD CONSTRAINT "Restaurant_invoicePrinterId_fkey" FOREIGN KEY ("invoicePrinterId") REFERENCES "Printer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
