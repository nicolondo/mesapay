-- A valid close can exceed INT4 even when each payment fits in INT4.
-- Preserve exact integer cents and the numeric API's safe-integer contract.
ALTER TABLE "Shift"
  ALTER COLUMN "openingCashCents" TYPE BIGINT,
  ALTER COLUMN "declaredCashCents" TYPE BIGINT,
  ALTER COLUMN "expectedCashCents" TYPE BIGINT,
  ALTER COLUMN "cashDiffCents" TYPE BIGINT;

ALTER TABLE "Shift"
  ADD CONSTRAINT "Shift_openingCashCents_safe_integer" CHECK ("openingCashCents" BETWEEN -9007199254740991 AND 9007199254740991),
  ADD CONSTRAINT "Shift_declaredCashCents_safe_integer" CHECK ("declaredCashCents" BETWEEN -9007199254740991 AND 9007199254740991),
  ADD CONSTRAINT "Shift_expectedCashCents_safe_integer" CHECK ("expectedCashCents" BETWEEN -9007199254740991 AND 9007199254740991),
  ADD CONSTRAINT "Shift_cashDiffCents_safe_integer" CHECK ("cashDiffCents" BETWEEN -9007199254740991 AND 9007199254740991);
