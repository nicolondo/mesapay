-- Mesa que acaba de pagar desde el celular (Mesas): cuántos minutos sale de
-- primera y en verde fuerte una mesa cuya cuenta la pagó el comensal desde su
-- celular (tarjeta, Apple/Google Pay o PSE) sin que nadie del equipo cobrara.
-- Default 3; 0 = no resaltar. Se edita en Configuración → Políticas operativas.
-- Columna aditiva con DEFAULT: no reescribe la tabla ni toca filas existentes.

-- AlterTable
ALTER TABLE "Restaurant" ADD COLUMN     "phonePaidHighlightMinutes" INTEGER NOT NULL DEFAULT 3;
