-- Montos contables en BIGINT. Un INT4 sólo llega a 2.147.483.647 centavos
-- ($21.474.836,47) y el asiento-resumen MENSUAL de ventas de un comercio
-- mediano lo pasa de largo: la generación automática de asientos (#521)
-- falló para Son y Melona en 2026-09 ($92 M) y 2026-10 ($241 M) con
-- "Unable to fit integer value ... into an INT4", y el comercio quedó sin
-- ningún asiento (estados financieros, balance y libros vacíos).
--
-- Además de las líneas de asiento se amplían los montos contables que
-- alimentan asientos o son totales de un período y que la app ya acepta por
-- encima de INT4 (o no topa): activos fijos (tope $500 M), diferidos (sin
-- tope), presupuesto mensual (tope $1.000 M), declaraciones de impuestos (un
-- bimestre de INC pasa los $21 M) y líneas del extracto bancario (sin tope).
--
-- INT4 → BIGINT es una conversión sin pérdida y conserva los DEFAULT 0.
-- Ninguna vista, trigger, índice ni CHECK depende de estas columnas (sólo
-- sus DEFAULT). Cada ALTER TABLE reescribe su tabla UNA vez bajo ACCESS
-- EXCLUSIVE; son tablas chicas (asientos-resumen y catálogos contables).
--
-- El CHECK fija el rango de enteros exactos de JavaScript (±(2^53 − 1)): la
-- app lee estos montos como `number` (src/lib/erp/ledgerCents.ts). Mismo
-- criterio que 20260928170000_shift_cash_bigint.

ALTER TABLE "JournalLine"
  ALTER COLUMN "debitCents" TYPE BIGINT,
  ALTER COLUMN "creditCents" TYPE BIGINT,
  ADD CONSTRAINT "JournalLine_debitCents_safe_integer" CHECK ("debitCents" BETWEEN -9007199254740991 AND 9007199254740991),
  ADD CONSTRAINT "JournalLine_creditCents_safe_integer" CHECK ("creditCents" BETWEEN -9007199254740991 AND 9007199254740991);

ALTER TABLE "FixedAsset"
  ALTER COLUMN "purchaseCents" TYPE BIGINT,
  ALTER COLUMN "salvageCents" TYPE BIGINT,
  ADD CONSTRAINT "FixedAsset_purchaseCents_safe_integer" CHECK ("purchaseCents" BETWEEN -9007199254740991 AND 9007199254740991),
  ADD CONSTRAINT "FixedAsset_salvageCents_safe_integer" CHECK ("salvageCents" BETWEEN -9007199254740991 AND 9007199254740991);

ALTER TABLE "DeferredItem"
  ALTER COLUMN "totalCents" TYPE BIGINT,
  ADD CONSTRAINT "DeferredItem_totalCents_safe_integer" CHECK ("totalCents" BETWEEN -9007199254740991 AND 9007199254740991);

ALTER TABLE "Budget"
  ALTER COLUMN "monthlyCents" TYPE BIGINT,
  ADD CONSTRAINT "Budget_monthlyCents_safe_integer" CHECK ("monthlyCents" BETWEEN -9007199254740991 AND 9007199254740991);

ALTER TABLE "TaxFiling"
  ALTER COLUMN "declaredCents" TYPE BIGINT,
  ADD CONSTRAINT "TaxFiling_declaredCents_safe_integer" CHECK ("declaredCents" BETWEEN -9007199254740991 AND 9007199254740991);

ALTER TABLE "BankStatementLine"
  ALTER COLUMN "amountCents" TYPE BIGINT,
  ADD CONSTRAINT "BankStatementLine_amountCents_safe_integer" CHECK ("amountCents" BETWEEN -9007199254740991 AND 9007199254740991);
