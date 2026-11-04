-- Gastos con documento soporte, impuestos y retenciones (misma convención
-- fiscal que las compras). ADITIVA: todas las columnas nuevas tienen
-- default, así que el código anterior (y las otras ramas que comparten la
-- base de demo) siguen creando gastos sin tocarlas.
--
-- Semántica: `amountCents` sigue siendo el COSTO que va al PYG; el total a
-- pagar al proveedor vive en `payableCents`. Los gastos que ya existen no
-- tienen impuestos: base = total a pagar = monto, así el saldo por pagar
-- (payable − abonado), la cartera y los asientos no cambian.

-- AlterTable
ALTER TABLE "Expense"
  ADD COLUMN "documentType" TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN "documentNumber" TEXT,
  ADD COLUMN "documentDate" TIMESTAMP(3),
  ADD COLUMN "attachmentUrl" TEXT,
  ADD COLUMN "baseCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "discountCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "ivaPct" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "ivaCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "ivaDeductible" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "incCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "retefuenteCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "reteIvaCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "reteIcaCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "payableCents" INTEGER NOT NULL DEFAULT 0;

-- Backfill: los gastos existentes no llevan impuestos.
UPDATE "Expense" SET "baseCents" = "amountCents", "payableCents" = "amountCents";

-- AlterTable: tipo de documento y de persona del proveedor (alta rápida
-- desde el gasto). Nulos = el comportamiento de siempre (se infieren).
ALTER TABLE "Supplier"
  ADD COLUMN "taxIdType" TEXT,
  ADD COLUMN "personType" TEXT;

-- CreateTable
CREATE TABLE "ExpenseRetention" (
    "id" TEXT NOT NULL,
    "expenseId" TEXT NOT NULL,
    "conceptId" TEXT,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rateBps" INTEGER NOT NULL,
    "base" TEXT NOT NULL DEFAULT 'subtotal',
    "accountCode" TEXT NOT NULL,
    "baseCents" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpenseRetention_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExpenseRetention_expenseId_idx" ON "ExpenseRetention"("expenseId");

-- CreateIndex
CREATE INDEX "ExpenseRetention_conceptId_idx" ON "ExpenseRetention"("conceptId");

-- AddForeignKey
ALTER TABLE "ExpenseRetention" ADD CONSTRAINT "ExpenseRetention_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "Expense"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseRetention" ADD CONSTRAINT "ExpenseRetention_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "RetentionConcept"("id") ON DELETE SET NULL ON UPDATE CASCADE;
