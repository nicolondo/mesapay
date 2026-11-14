-- Pagos a proveedores con comprobante de egreso («Pagar a proveedor»).
--
--   SupplierPayment                 → el comprobante (CE-0001): proveedor,
--                                     fecha, cuenta de dinero, medio,
--                                     referencia, soporte, dinero pagado y su
--                                     reparto (compras / gastos / anticipo).
--   PurchasePayment / ExpensePayment
--     .supplierPaymentId            → comprobante que creó la fila (pago en
--                                     dinero o cruce hecho al pagar).
--     .supplierAdvanceId            → anticipo que la fila consume.
--
-- Aditivo: tabla nueva (el índice único del consecutivo nace sobre una tabla
-- vacía) y columnas NULL sin default en tablas existentes (sólo metadatos).
-- La versión anterior no lee ni escribe nada de esto; con rollback, los
-- abonos creados por un comprobante siguen bajando el saldo de cada factura.

-- AlterTable
ALTER TABLE "PurchasePayment" ADD COLUMN     "supplierAdvanceId" TEXT,
ADD COLUMN     "supplierPaymentId" TEXT;

-- AlterTable
ALTER TABLE "ExpensePayment" ADD COLUMN     "supplierAdvanceId" TEXT,
ADD COLUMN     "supplierPaymentId" TEXT;

-- CreateTable
CREATE TABLE "SupplierPayment" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "accountCode" TEXT NOT NULL,
    "method" TEXT,
    "reference" TEXT,
    "note" TEXT,
    "attachmentUrl" TEXT,
    "amountCents" INTEGER NOT NULL,
    "purchaseCents" INTEGER NOT NULL DEFAULT 0,
    "expenseCents" INTEGER NOT NULL DEFAULT 0,
    "advanceCents" INTEGER NOT NULL DEFAULT 0,
    "creditAppliedCents" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "voidedById" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PurchasePayment_supplierPaymentId_idx" ON "PurchasePayment"("supplierPaymentId");

-- CreateIndex
CREATE INDEX "PurchasePayment_supplierAdvanceId_idx" ON "PurchasePayment"("supplierAdvanceId");

-- CreateIndex
CREATE INDEX "ExpensePayment_supplierPaymentId_idx" ON "ExpensePayment"("supplierPaymentId");

-- CreateIndex
CREATE INDEX "ExpensePayment_supplierAdvanceId_idx" ON "ExpensePayment"("supplierAdvanceId");

-- CreateIndex
CREATE INDEX "SupplierPayment_restaurantId_date_idx" ON "SupplierPayment"("restaurantId", "date");

-- CreateIndex
CREATE INDEX "SupplierPayment_restaurantId_supplierId_idx" ON "SupplierPayment"("restaurantId", "supplierId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierPayment_restaurantId_number_key" ON "SupplierPayment"("restaurantId", "number");

-- AddForeignKey
ALTER TABLE "PurchasePayment" ADD CONSTRAINT "PurchasePayment_supplierPaymentId_fkey" FOREIGN KEY ("supplierPaymentId") REFERENCES "SupplierPayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchasePayment" ADD CONSTRAINT "PurchasePayment_supplierAdvanceId_fkey" FOREIGN KEY ("supplierAdvanceId") REFERENCES "SupplierPayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpensePayment" ADD CONSTRAINT "ExpensePayment_supplierPaymentId_fkey" FOREIGN KEY ("supplierPaymentId") REFERENCES "SupplierPayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpensePayment" ADD CONSTRAINT "ExpensePayment_supplierAdvanceId_fkey" FOREIGN KEY ("supplierAdvanceId") REFERENCES "SupplierPayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

