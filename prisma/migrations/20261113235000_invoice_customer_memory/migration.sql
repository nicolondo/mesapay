-- "Recordar mis datos" de la factura personalizada (ver
-- src/lib/invoiceCustomerMemory.ts) y varios correos por factura (ver
-- src/lib/invoiceEmails.ts). Escrita a mano y SOLO ADITIVA: columnas
-- nuevas con default o nulas y una tabla nueva. La versión anterior de la app
-- (deploy blue/green) sigue funcionando con este esquema: no lee ni escribe
-- nada de esto, y sus INSERT toman los defaults (selfService=false,
-- fromSavedCustomer=false, ccEmails vacío), que es justo lo correcto para lo
-- que ella crea (clientes del personal, solicitudes escritas a mano, un
-- solo correo).
--
-- No se tocan filas existentes: los clientes de facturación que ya existen
-- quedan como del personal (selfService=false) y ninguna solicitud vieja
-- queda marcada como "de un cliente guardado".


-- AlterTable
ALTER TABLE "BillingCustomer" ADD COLUMN     "ccEmails" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "rememberConsentAt" TIMESTAMP(3),
ADD COLUMN     "rememberOptOutAt" TIMESTAMP(3),
ADD COLUMN     "selfService" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "InvoiceRequest" ADD COLUMN     "ccEmails" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "fromSavedCustomer" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "rememberCustomer" BOOLEAN;

-- CreateTable
CREATE TABLE "InvoiceCustomerLookup" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "billingCustomerId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InvoiceCustomerLookup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceCustomerLookup_tokenHash_key" ON "InvoiceCustomerLookup"("tokenHash");

-- CreateIndex
CREATE INDEX "InvoiceCustomerLookup_orderId_idx" ON "InvoiceCustomerLookup"("orderId");

-- CreateIndex
CREATE INDEX "InvoiceCustomerLookup_billingCustomerId_idx" ON "InvoiceCustomerLookup"("billingCustomerId");

-- AddForeignKey
ALTER TABLE "InvoiceCustomerLookup" ADD CONSTRAINT "InvoiceCustomerLookup_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceCustomerLookup" ADD CONSTRAINT "InvoiceCustomerLookup_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceCustomerLookup" ADD CONSTRAINT "InvoiceCustomerLookup_billingCustomerId_fkey" FOREIGN KEY ("billingCustomerId") REFERENCES "BillingCustomer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
