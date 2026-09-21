-- Presupuestos por cuenta y mes con centro de costos opcional, y activos
-- fijos con cuentas propias (depreciación acumulada / gasto), código y notas.
--
-- Budget:
--   month: 1..12; NULL = aplica a todos los meses del año (las filas que ya
--     existían quedan anuales, así no cambia lo que el comercio veía).
--   costCenterId: NULL = presupuesto general de la cuenta.
--   La unicidad por alcance NO puede ser un @@unique de Prisma: PostgreSQL
--   trata los NULL como distintos y dejaría duplicar el general o el anual.
--   Se crea acá como índice único sobre COALESCE; el código
--   (src/lib/erp/budgets.ts) busca la fila por alcance antes de insertar.
-- FixedAsset: columnas nuevas con default, así las filas actuales siguen
--   depreciando contra 516005 / 159205 como hasta ahora.

-- DropIndex
DROP INDEX "Budget_restaurantId_year_accountCode_key";

-- AlterTable
ALTER TABLE "Budget" ADD COLUMN     "month" INTEGER,
ADD COLUMN     "costCenterId" TEXT;

-- CreateIndex
CREATE INDEX "Budget_restaurantId_year_idx" ON "Budget"("restaurantId", "year");

-- CreateIndex
CREATE INDEX "Budget_costCenterId_idx" ON "Budget"("costCenterId");

-- Unicidad por alcance (ver cabecera): mes NULL → 0, centro NULL → ''.
CREATE UNIQUE INDEX "Budget_scope_key" ON "Budget"("restaurantId", "year", COALESCE("month", 0), "accountCode", COALESCE("costCenterId", ''));

-- AddForeignKey
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_costCenterId_fkey" FOREIGN KEY ("costCenterId") REFERENCES "CostCenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "FixedAsset" ADD COLUMN     "code" TEXT,
ADD COLUMN     "depreciationAccountCode" TEXT NOT NULL DEFAULT '159205',
ADD COLUMN     "expenseAccountCode" TEXT NOT NULL DEFAULT '516005',
ADD COLUMN     "notes" TEXT;
