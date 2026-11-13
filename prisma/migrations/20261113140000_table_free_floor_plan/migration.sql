-- Plano del salón de forma libre (v2).
--
-- SOLO ADITIVA: cinco columnas nuevas, opcionales y sin default, en
-- "Table". No cambia el tipo ni el significado de "floorPlanX" /
-- "floorPlanY" (siguen siendo la celda del plano viejo) ni toca
-- "Restaurant"."floorPlan". En PostgreSQL agregar columnas NULL sin
-- default no reescribe la tabla: es un cambio de catálogo, instantáneo.
--
-- Segura en blue/green y ante rollback: la versión anterior nunca
-- selecciona estas columnas (Prisma pide las suyas por nombre), así que
-- sigue funcionando igual con el esquema nuevo. El plano existente NO se
-- migra acá: el código nuevo lo convierte al vuelo al leer
-- (src/lib/floorPlan.ts → resolveFloor) y recién al guardar escribe el
-- formato nuevo.

-- AlterTable
ALTER TABLE "Table" ADD COLUMN     "floorX" DOUBLE PRECISION,
ADD COLUMN     "floorY" DOUBLE PRECISION,
ADD COLUMN     "floorW" DOUBLE PRECISION,
ADD COLUMN     "floorH" DOUBLE PRECISION,
ADD COLUMN     "floorRotation" DOUBLE PRECISION;
