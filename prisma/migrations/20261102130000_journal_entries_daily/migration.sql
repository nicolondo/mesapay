-- El motor contable pasa a asentar las fuentes transaccionales por fuente y
-- DÍA de negocio (varios asientos por mes con el mismo `sourceRef = "YYYY-MM"`),
-- así que la unicidad por (restaurante, fuente, sourceRef) ya no aplica: pasa
-- a incluir la fecha del asiento. El índice nuevo sigue cubriendo las
-- consultas por prefijo (restaurante, fuente, sourceRef) que usa el motor.
-- Nunca falla sobre datos existentes: la unicidad anterior implica la nueva.

-- DropIndex
DROP INDEX "JournalEntry_restaurantId_source_sourceRef_key";

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_restaurantId_source_sourceRef_date_key" ON "JournalEntry"("restaurantId", "source", "sourceRef", "date");
