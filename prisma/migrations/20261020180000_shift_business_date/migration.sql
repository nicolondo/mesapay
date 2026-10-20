BEGIN;

-- Additive and nullable for old application versions and older snapshots.
-- Every new insert receives its opening's business date before it is stored.
ALTER TABLE "Shift" ADD COLUMN "businessDate" DATE;

CREATE FUNCTION mesapay_set_shift_business_date() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cutoff_hour integer;
BEGIN
  IF NEW."businessDate" IS NULL THEN
    SELECT "businessDayCutoffHour" INTO cutoff_hour
      FROM "Restaurant" WHERE id = NEW."restaurantId";
    -- Prisma's timestamp(3) holds UTC without a timezone. Convert explicitly
    -- so the session timezone cannot move the date. Keep supplied dates when
    -- restoring; this trigger also fills omissions from older app versions.
    NEW."businessDate" := (
      (NEW."openedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')
      - make_interval(hours => COALESCE(cutoff_hour, 0))
    )::date;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER set_shift_business_date BEFORE INSERT ON "Shift"
FOR EACH ROW EXECUTE FUNCTION mesapay_set_shift_business_date();

-- Historical cutoff values were not recorded. Backfill using each
-- restaurant's current cutoff, preserving every timestamp and cash amount.
UPDATE "Shift" AS s
SET "businessDate" = (
  (s."openedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota')
  - make_interval(hours => r."businessDayCutoffHour")
)::date
FROM "Restaurant" AS r
WHERE r.id = s."restaurantId" AND s."businessDate" IS NULL;

COMMIT;
