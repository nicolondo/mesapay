-- Bre-B (pagos inmediatos por QR) como método de pago propio.
--
--   PaymentMethod.kushki_bre_b → cobro por QR Bre-B vía Kushki «Transfer In».
--
-- Va SOLO en su migración, igual que `cash` (20260918170000): PostgreSQL no
-- deja usar un valor de enum en la misma transacción que lo agrega, así que
-- nada de esta migración lo referencia. Las columnas y la tabla que sí lo
-- acompañan están en la migración siguiente. Aditivo: no reescribe filas.

-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE 'kushki_bre_b';
