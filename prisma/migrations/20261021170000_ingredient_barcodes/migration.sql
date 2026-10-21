-- Serialize legacy writers with the backfill and trigger installation.
BEGIN;
LOCK TABLE "Ingredient" IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE "IngredientBarcode" (
  "id" TEXT NOT NULL,
  "restaurantId" TEXT NOT NULL,
  "ingredientId" TEXT NOT NULL,
  "barcode" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IngredientBarcode_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "IngredientBarcode_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "IngredientBarcode_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "IngredientBarcode_restaurantId_barcode_key" ON "IngredientBarcode"("restaurantId", "barcode");
CREATE INDEX "IngredientBarcode_ingredientId_idx" ON "IngredientBarcode"("ingredientId");

INSERT INTO "IngredientBarcode" ("id", "restaurantId", "ingredientId", "barcode", "createdAt")
SELECT gen_random_uuid()::text, "restaurantId", "id", "barcode", "createdAt"
FROM "Ingredient" WHERE "barcode" IS NOT NULL;

CREATE FUNCTION ingredient_barcode_owner_check() RETURNS TRIGGER AS $$
BEGIN
  PERFORM 1 FROM "Ingredient" WHERE "id" = NEW."ingredientId" AND "restaurantId" = NEW."restaurantId" FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ingredient_barcode_owner_mismatch' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER ingredient_barcode_owner_check BEFORE INSERT OR UPDATE OF "ingredientId", "restaurantId"
ON "IngredientBarcode" FOR EACH ROW EXECUTE FUNCTION ingredient_barcode_owner_check();

CREATE FUNCTION sync_ingredient_primary_barcode() RETURNS TRIGGER AS $$
BEGIN
  IF current_setting('app.restoring', true) = '1' THEN
    IF current_setting('app.ingredient_barcodes_restore', true) IS DISTINCT FROM '1' THEN
      RAISE EXCEPTION 'ingredient_barcodes_restore_requires_current_release';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  -- There is no supported cross-merchant move. Keep aliases tenant-owned.
  IF TG_OP = 'UPDATE' AND OLD."restaurantId" IS DISTINCT FROM NEW."restaurantId" THEN
    RAISE EXCEPTION 'ingredient_restaurant_immutable';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."barcode" IS DISTINCT FROM NEW."barcode" THEN
    DELETE FROM "IngredientBarcode" WHERE "ingredientId" = NEW."id" AND "barcode" = OLD."barcode";
  END IF;
  IF NEW."barcode" IS NOT NULL THEN
    INSERT INTO "IngredientBarcode" ("id", "restaurantId", "ingredientId", "barcode")
    SELECT gen_random_uuid()::text, NEW."restaurantId", NEW."id", NEW."barcode"
    WHERE NOT EXISTS (
      SELECT 1 FROM "IngredientBarcode"
      WHERE "restaurantId" = NEW."restaurantId" AND "ingredientId" = NEW."id" AND "barcode" = NEW."barcode"
    );
    -- A conflicting alias on another ingredient raises the unique violation;
    -- the enclosing statement rolls back, including deletion of OLD.barcode.
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER sync_ingredient_primary_barcode AFTER INSERT OR UPDATE OF "barcode", "restaurantId"
ON "Ingredient" FOR EACH ROW EXECUTE FUNCTION sync_ingredient_primary_barcode();
CREATE TRIGGER guard_ingredient_barcode_restore BEFORE DELETE
ON "Ingredient" FOR EACH ROW EXECUTE FUNCTION sync_ingredient_primary_barcode();

-- Prevent a draining/rolled-back legacy process from making a snapshot that
-- silently omits additional codes. Older existing snapshots remain readable.
CREATE FUNCTION guard_ingredient_barcodes_backup() RETURNS TRIGGER AS $$
BEGIN
  IF jsonb_typeof(NEW."data"->'tables'->'IngredientBarcode') IS DISTINCT FROM 'array'
    AND EXISTS (
      SELECT 1 FROM "IngredientBarcode" b JOIN "Ingredient" i ON i."id" = b."ingredientId"
      WHERE b."restaurantId" = NEW."restaurantId" AND b."barcode" IS DISTINCT FROM i."barcode"
    ) THEN
    RAISE EXCEPTION 'ingredient_barcodes_backup_requires_current_release';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER guard_ingredient_barcodes_backup BEFORE INSERT OR UPDATE OF "data"
ON "RestaurantBackup" FOR EACH ROW EXECUTE FUNCTION guard_ingredient_barcodes_backup();
COMMIT;
