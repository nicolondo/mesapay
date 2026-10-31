-- Aditiva: cuenta las respuestas «no encontrado» (66/90) seguidas de la
-- consulta de estado DIAN de una nota crédito, para marcarla «No recibida por
-- la DIAN» con el umbral de la aplicación. Las filas existentes arrancan en 0:
-- el umbral se alcanza con consultas nuevas, nunca con datos inventados.
-- Una versión anterior de la aplicación ignora la columna; en un rollback de
-- la aplicación se conserva.
ALTER TABLE "DianDocument"
  ADD COLUMN "statusNotFoundCount" INTEGER NOT NULL DEFAULT 0;
