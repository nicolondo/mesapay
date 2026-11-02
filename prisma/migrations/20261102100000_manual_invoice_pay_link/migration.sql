-- Link de pago para la FACTURA MANUAL.
--
--   PaymentLinkKind.order   → el link no cobra un monto fijo: da entrada,
--                             con un token aleatorio, al checkout del
--                             comensal de esa orden (/t/[slug]/pay/[orderId]).
--                             Al pagarse, la cuenta sigue el mismo camino que
--                             cualquier cobro en línea (Payment, factura,
--                             DIAN, contabilidad). Ver
--                             src/lib/manualInvoicePayLink.ts.
--   PaymentLink.orderId     → la cuenta a la que da entrada (uno por orden).
--   PaymentLink.emailSentAt → último envío por correo (con payerEmail).

-- AlterEnum
ALTER TYPE "PaymentLinkKind" ADD VALUE 'order';

-- AlterTable
ALTER TABLE "PaymentLink" ADD COLUMN     "emailSentAt" TIMESTAMP(3),
ADD COLUMN     "orderId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "PaymentLink_orderId_key" ON "PaymentLink"("orderId");

-- AddForeignKey
ALTER TABLE "PaymentLink" ADD CONSTRAINT "PaymentLink_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
