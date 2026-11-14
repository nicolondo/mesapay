-- Conceptos de retención creados por el comercio (desde el catálogo o
-- personalizados) y tarifa con más precisión que los basis points (la
-- reteICA va por mil: 4,14 ‰ = 41,4 bps no cabe en un entero).
--
-- Solo ADITIVA: columnas opcionales o con default. La versión anterior del
-- código (blue/green, rollback) sigue leyendo y escribiendo `rateBps`; la
-- nueva escribe las dos (rateBps redondeado + ratePpm exacto) y lee
-- ratePpm cuando existe.
ALTER TABLE "RetentionConcept" ADD COLUMN "ratePpm" INTEGER;
ALTER TABLE "RetentionConcept" ADD COLUMN "catalogKey" TEXT;
ALTER TABLE "RetentionConcept" ADD COLUMN "isCustom" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "ExpenseRetention" ADD COLUMN "ratePpm" INTEGER;

-- Marca de siembra: borrar todos los conceptos no los vuelve a sembrar.
ALTER TABLE "AccountingConfig" ADD COLUMN "retentionConceptsSeededAt" TIMESTAMP(3);
