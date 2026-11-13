-- Datáfono Kushki: el monto que Kushki AUTORIZÓ cuando no es el de la cuenta,
-- y qué se hizo con la diferencia (propina, saldo pendiente o conciliar).
--
-- Aditivo y nullable: no reescribe filas y la versión anterior (blue/green)
-- sigue sirviendo con el esquema nuevo sin leer estas columnas.
-- BIGINT: lo que se guarda puede ser justo un error de unidades (×100) de una
-- cuenta grande, que no cabe en INT4 ($500.000 × 100 en centavos).

-- AlterTable
ALTER TABLE "FinancialOperation" ADD COLUMN "authorizedCents" BIGINT;
ALTER TABLE "FinancialOperation" ADD COLUMN "amountCheck" TEXT;
