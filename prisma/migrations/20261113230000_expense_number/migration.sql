-- Consecutivo interno de gastos («G-0001») por comercio.
--
-- Aditiva y segura con blue/green: la columna es NULLABLE y el contador
-- tiene default, así que la versión vieja del código sigue creando gastos
-- (quedan con "number" NULL). La nueva numera esos gastos pendientes —en
-- orden de creación— la próxima vez que se crea un gasto o se abre la lista
-- (src/lib/erp/expenseNumber.ts). Las plantillas recurrentes no se numeran.

-- AlterTable
ALTER TABLE "Restaurant" ADD COLUMN "expenseNextNumber" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "Expense" ADD COLUMN "number" INTEGER;

-- backfill:start
-- Los gastos existentes (no las plantillas) se numeran 1..n por comercio en
-- orden de creación; el contador queda en el siguiente al mayor asignado.
-- (integration/expense-number.test.ts ejecuta este mismo bloque.)
WITH ranked AS (
  SELECT e."id",
         COALESCE(m."maxNumber", 0)
           + ROW_NUMBER() OVER (PARTITION BY e."restaurantId" ORDER BY e."createdAt", e."id") AS "n"
  FROM "Expense" e
  LEFT JOIN (
    SELECT "restaurantId", MAX("number") AS "maxNumber"
    FROM "Expense"
    GROUP BY "restaurantId"
  ) m ON m."restaurantId" = e."restaurantId"
  WHERE e."recurring" = false AND e."number" IS NULL
)
UPDATE "Expense" e SET "number" = ranked."n" FROM ranked WHERE e."id" = ranked."id";

UPDATE "Restaurant" r
SET "expenseNextNumber" = GREATEST(r."expenseNextNumber", m."maxNumber" + 1)
FROM (
  SELECT "restaurantId", MAX("number") AS "maxNumber"
  FROM "Expense"
  WHERE "number" IS NOT NULL
  GROUP BY "restaurantId"
) m
WHERE r."id" = m."restaurantId";
-- backfill:end

-- CreateIndex (Postgres admite varios NULL: plantillas y gastos pendientes)
CREATE UNIQUE INDEX "Expense_restaurantId_number_key" ON "Expense"("restaurantId", "number");
