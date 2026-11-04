-- Datáfono Kushki sin respuesta (Son y Melona, 2026-11-04: el gateway de
-- Kushki cortó dos cobros síncronos a los 60 s con un 504): el reclamo
-- `terminal:<paymentId>` guarda el `client_transaction_id` con el que se
-- empujó el cobro (para buscar el resultado real en Kushki con
-- `transaction_search_online`) y la última consulta.
-- Columnas aditivas y NULLABLE: no reescriben la tabla ni tocan filas
-- existentes (los reclamos viejos no se pueden consultar y siguen como hoy).

-- AlterTable
ALTER TABLE "FinancialOperation" ADD COLUMN     "clientTransactionId" TEXT,
ADD COLUMN     "checkedAt" TIMESTAMP(3),
ADD COLUMN     "checkStatus" TEXT;
