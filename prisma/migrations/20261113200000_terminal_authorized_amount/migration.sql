-- Datáfono Kushki: el monto que Kushki AUTORIZÓ cuando no es el de la cuenta,
-- y qué se hizo con la diferencia (propina, saldo pendiente o conciliar).
--
-- Aditivo y nullable: no reescribe filas y la versión anterior (blue/green)
-- sigue sirviendo con el esquema nuevo sin leer estas columnas.

-- AlterTable
ALTER TABLE "FinancialOperation" ADD COLUMN "authorizedCents" INTEGER;
ALTER TABLE "FinancialOperation" ADD COLUMN "amountCheck" TEXT;
