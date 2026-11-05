-- Notificaciones de la DIAN de cada documento («Regla: X, Notificación: …»),
-- que no son rechazos. Aditiva: columna nueva, nullable, sin default ni
-- backfill.
ALTER TABLE "DianDocument" ADD COLUMN "warnings" JSONB;
