-- Notas crédito de proveedores (descuento comercial, acuerdo comercial,
-- pronto pago, devolución).
--
--   SupplierCreditNote         → la nota: proveedor, número, fecha, CUDE,
--                                tipo, acuerdo, valor, IVA/INC discriminados,
--                                cuenta contrapartida, soporte, anulación.
--   SupplierCreditNoteLine     → insumos devueltos (sólo devoluciones).
--   SupplierCreditNoteInvoice  → compras que la nota referencia.
--   SupplierCreditNoteRefund   → reintegro en dinero de un saldo a favor.
--   PurchasePayment / ExpensePayment.supplierCreditNoteId
--                              → el CRUCE de la nota con una compra o un
--                                gasto (baja su saldo como un abono).
--   StockMovement.supplierCreditNoteId
--                              → salida del kardex de una devolución.
--
-- Todo aditivo: tablas nuevas y columnas NULL sin default (sólo metadatos,
-- no reescribe filas). La versión anterior no lee ni escribe nada de esto;
-- con rollback, los cruces ya hechos siguen bajando el saldo de las compras
-- (son abonos) y la nota simplemente no se asienta. Sin índice nuevo sobre
-- StockMovement (tabla grande; las notas nunca se borran en operación).

-- AlterTable
ALTER TABLE "StockMovement" ADD COLUMN     "supplierCreditNoteId" TEXT;

-- AlterTable
ALTER TABLE "PurchasePayment" ADD COLUMN     "supplierCreditNoteId" TEXT;

-- AlterTable
ALTER TABLE "ExpensePayment" ADD COLUMN     "supplierCreditNoteId" TEXT;

-- CreateTable
CREATE TABLE "SupplierCreditNote" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "cude" TEXT,
    "kind" TEXT NOT NULL,
    "agreement" VARCHAR(120),
    "totalCents" INTEGER NOT NULL,
    "ivaPct" INTEGER NOT NULL DEFAULT 0,
    "ivaCents" INTEGER NOT NULL DEFAULT 0,
    "ivaDeductible" BOOLEAN NOT NULL DEFAULT false,
    "incCents" INTEGER NOT NULL DEFAULT 0,
    "accountCode" TEXT,
    "note" TEXT,
    "attachmentUrl" TEXT,
    "extraction" JSONB,
    "status" TEXT NOT NULL DEFAULT 'active',
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "voidedById" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierCreditNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierCreditNoteLine" (
    "id" TEXT NOT NULL,
    "creditNoteId" TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "purchaseOrderItemId" TEXT,
    "qtyBase" INTEGER NOT NULL,
    "valueCents" INTEGER NOT NULL,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "inventoried" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "SupplierCreditNoteLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierCreditNoteRefund" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "creditNoteId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "accountCode" TEXT NOT NULL,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierCreditNoteRefund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierCreditNoteInvoice" (
    "id" TEXT NOT NULL,
    "creditNoteId" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,

    CONSTRAINT "SupplierCreditNoteInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupplierCreditNote_restaurantId_date_idx" ON "SupplierCreditNote"("restaurantId", "date");

-- CreateIndex
CREATE INDEX "SupplierCreditNote_restaurantId_supplierId_idx" ON "SupplierCreditNote"("restaurantId", "supplierId");

-- CreateIndex
CREATE INDEX "SupplierCreditNote_restaurantId_voidedAt_idx" ON "SupplierCreditNote"("restaurantId", "voidedAt");

-- CreateIndex
CREATE INDEX "SupplierCreditNoteLine_creditNoteId_idx" ON "SupplierCreditNoteLine"("creditNoteId");

-- CreateIndex
CREATE INDEX "SupplierCreditNoteLine_ingredientId_idx" ON "SupplierCreditNoteLine"("ingredientId");

-- CreateIndex
CREATE INDEX "SupplierCreditNoteRefund_creditNoteId_idx" ON "SupplierCreditNoteRefund"("creditNoteId");

-- CreateIndex
CREATE INDEX "SupplierCreditNoteRefund_restaurantId_receivedAt_idx" ON "SupplierCreditNoteRefund"("restaurantId", "receivedAt");

-- CreateIndex
CREATE INDEX "SupplierCreditNoteInvoice_purchaseOrderId_idx" ON "SupplierCreditNoteInvoice"("purchaseOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierCreditNoteInvoice_creditNoteId_purchaseOrderId_key" ON "SupplierCreditNoteInvoice"("creditNoteId", "purchaseOrderId");

-- CreateIndex
CREATE INDEX "PurchasePayment_supplierCreditNoteId_idx" ON "PurchasePayment"("supplierCreditNoteId");

-- CreateIndex
CREATE INDEX "ExpensePayment_supplierCreditNoteId_idx" ON "ExpensePayment"("supplierCreditNoteId");

-- AddForeignKey
-- NOT VALID: la columna acaba de nacer en NULL en todas las filas, así que no
-- hay nada que validar; así no se recorre StockMovement (tabla grande) bajo
-- candado. Las filas nuevas sí se validan.
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_supplierCreditNoteId_fkey" FOREIGN KEY ("supplierCreditNoteId") REFERENCES "SupplierCreditNote"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

-- AddForeignKey
ALTER TABLE "PurchasePayment" ADD CONSTRAINT "PurchasePayment_supplierCreditNoteId_fkey" FOREIGN KEY ("supplierCreditNoteId") REFERENCES "SupplierCreditNote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierCreditNote" ADD CONSTRAINT "SupplierCreditNote_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierCreditNote" ADD CONSTRAINT "SupplierCreditNote_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierCreditNoteLine" ADD CONSTRAINT "SupplierCreditNoteLine_creditNoteId_fkey" FOREIGN KEY ("creditNoteId") REFERENCES "SupplierCreditNote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierCreditNoteLine" ADD CONSTRAINT "SupplierCreditNoteLine_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierCreditNoteLine" ADD CONSTRAINT "SupplierCreditNoteLine_purchaseOrderItemId_fkey" FOREIGN KEY ("purchaseOrderItemId") REFERENCES "PurchaseOrderItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierCreditNoteRefund" ADD CONSTRAINT "SupplierCreditNoteRefund_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierCreditNoteRefund" ADD CONSTRAINT "SupplierCreditNoteRefund_creditNoteId_fkey" FOREIGN KEY ("creditNoteId") REFERENCES "SupplierCreditNote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierCreditNoteInvoice" ADD CONSTRAINT "SupplierCreditNoteInvoice_creditNoteId_fkey" FOREIGN KEY ("creditNoteId") REFERENCES "SupplierCreditNote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierCreditNoteInvoice" ADD CONSTRAINT "SupplierCreditNoteInvoice_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpensePayment" ADD CONSTRAINT "ExpensePayment_supplierCreditNoteId_fkey" FOREIGN KEY ("supplierCreditNoteId") REFERENCES "SupplierCreditNote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

