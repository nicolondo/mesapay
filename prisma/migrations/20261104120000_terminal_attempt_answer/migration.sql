-- Datáfono Kushki cancelado en el equipo (Son y Melona, 2026-11-04): el
-- reclamo `terminal:<paymentId>` guarda a qué equipo se mandó el cobro y qué
-- respondió el equipo cuando NO aprobó. Con eso la cuenta distingue "el
-- datáfono respondió que no" (reintentar / cancelar al instante) de "no hubo
-- respuesta" (puede haber cobrado: 3 minutos + administrador + evidencia), y
-- la pantalla del comensal sigue al reintento.
-- Columnas aditivas y NULLABLE: no reescriben la tabla ni tocan filas
-- existentes (los reclamos viejos quedan "sin respuesta", como hasta hoy).

-- AlterTable
ALTER TABLE "FinancialOperation" ADD COLUMN     "deviceId" TEXT,
ADD COLUMN     "answerCode" TEXT,
ADD COLUMN     "answerMessage" TEXT,
ADD COLUMN     "answeredAt" TIMESTAMP(3),
ADD COLUMN     "nextPaymentId" TEXT;
