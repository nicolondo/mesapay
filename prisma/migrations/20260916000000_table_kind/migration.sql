-- Tipo explícito de mesa. Hasta ahora las mesas "pseudo" eran una
-- convención por número (pickup = -1, mostrador = 0) y no había forma de
-- distinguir una pseudo-mesa nueva de otra sin repartirse rangos a ojo.
--
--   standard → mesa física (o el mostrador, número 0).
--   pickup   → la mesa oculta del pedido anticipado (número -1).
--   manual   → "factura manual": una orden sin mesa física que se cobra
--              como cualquier otra. Una fila por factura abierta, números
--              desde -100 hacia abajo (ver src/lib/manualInvoice.ts).
--
-- Los números negativos se conservan: todos los guards `number < 0`
-- existentes siguen excluyendo las pseudo-mesas sin tocarlos.

-- CreateEnum
CREATE TYPE "TableKind" AS ENUM ('standard', 'pickup', 'manual');

-- AlterTable
ALTER TABLE "Table" ADD COLUMN "kind" "TableKind" NOT NULL DEFAULT 'standard';

-- Backfill: la mesa de recogida ya existía por convención (número -1).
UPDATE "Table" SET "kind" = 'pickup' WHERE "number" = -1;

-- CreateIndex
CREATE INDEX "Table_restaurantId_kind_idx" ON "Table"("restaurantId", "kind");
