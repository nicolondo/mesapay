import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";

const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["127.0.0.1", "localhost"].includes(database.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname)) {
  throw new Error("Isolated local database required");
}
const tenants: string[] = [];
let restaurantId = "";
beforeEach(async () => {
  const restaurant = await db.restaurant.create({ data: { name: "Barcode registry", slug: `barcodes-${randomUUID()}` } });
  restaurantId = restaurant.id;
  tenants.push(restaurantId);
});
afterAll(async () => {
  await db.restaurant.deleteMany({ where: { id: { in: tenants } } });
  await db.$disconnect();
});
const ingredient = (name: string, barcode: string | null = null) => db.ingredient.create({ data: { restaurantId, name, barcode, measureKind: "count" } });
const codes = (ingredientId: string) => db.$queryRaw<{ barcode: string }[]>`SELECT "barcode" FROM "IngredientBarcode" WHERE "ingredientId" = ${ingredientId} ORDER BY "barcode"`;
const add = (ingredientId: string, barcode: string, owner = restaurantId) => db.$executeRaw`INSERT INTO "IngredientBarcode" ("id", "restaurantId", "ingredientId", "barcode") VALUES (${randomUUID()}, ${owner}, ${ingredientId}, ${barcode})`;

describe("canonical ingredient barcode registry", () => {
  it("syncs legacy primary writes and preserves additional codes during replacement and clearing", async () => {
    const item = await ingredient("Water", "0001");
    expect(await codes(item.id)).toEqual([{ barcode: "0001" }]);
    await add(item.id, "ab12");
    await db.ingredient.update({ where: { id: item.id }, data: { barcode: "0002" } });
    expect(await codes(item.id)).toEqual([{ barcode: "0002" }, { barcode: "ab12" }]);
    await db.ingredient.update({ where: { id: item.id }, data: { barcode: null } });
    expect(await codes(item.id)).toEqual([{ barcode: "ab12" }]);
    await db.ingredient.update({ where: { id: item.id }, data: { barcode: "ab12" } });
    expect(await codes(item.id)).toEqual([{ barcode: "ab12" }]);
  });

  it("rejects primary/alias collisions atomically, including writes from old releases", async () => {
    const first = await ingredient("Water", "0001");
    const second = await ingredient("Rice", "0002");
    await add(first.id, "alias");
    await expect(db.ingredient.update({ where: { id: second.id }, data: { barcode: "alias" } })).rejects.toThrow();
    expect(await codes(second.id)).toEqual([{ barcode: "0002" }]);
    expect((await db.ingredient.findUniqueOrThrow({ where: { id: second.id } })).barcode).toBe("0002");
    await expect(ingredient("Another water", "alias")).rejects.toThrow();
    await expect(add(second.id, "alias")).rejects.toThrow();
  });

  it("isolates codes by merchant and rejects an inconsistent owner", async () => {
    const first = await ingredient("Water", "0001");
    const foreign = await db.restaurant.create({ data: { name: "Other merchant", slug: `barcodes-other-${randomUUID()}` } });
    tenants.push(foreign.id);
    const second = await db.ingredient.create({ data: { restaurantId: foreign.id, name: "Water", barcode: "0001", measureKind: "count" } });
    expect(await codes(second.id)).toEqual([{ barcode: "0001" }]);
    await expect(add(first.id, "foreign-code", foreign.id)).rejects.toThrow();
    await expect(db.ingredient.update({ where: { id: first.id }, data: { restaurantId: foreign.id, name: "Moved", barcode: "moved" } })).rejects.toThrow("ingredient_restaurant_immutable");
  });

  it("blocks legacy restorers before they can discard additional codes", async () => {
    const item = await ingredient("Water", "0001");
    await add(item.id, "alias");
    await expect(db.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL app.restoring = '1'`;
      await tx.ingredient.delete({ where: { id: item.id } });
    })).rejects.toThrow();
    expect(await codes(item.id)).toHaveLength(2);
  });

  it("lets the current restorer load canonical records without double insertion", async () => {
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL app.restoring = '1'`;
      await tx.$executeRaw`SET LOCAL app.ingredient_barcodes_restore = '1'`;
      const item = await tx.ingredient.create({ data: { restaurantId, name: "Snapshot", barcode: "0001", measureKind: "count" } });
      expect(await tx.$queryRaw`SELECT * FROM "IngredientBarcode" WHERE "ingredientId" = ${item.id}`).toEqual([]);
      await tx.$executeRaw`INSERT INTO "IngredientBarcode" ("id", "restaurantId", "ingredientId", "barcode") VALUES (${randomUUID()}, ${restaurantId}, ${item.id}, '0001')`;
    });
  });

  it("blocks incomplete new backups once the merchant has additional barcodes", async () => {
    const item = await ingredient("Water", "0001");
    await add(item.id, "alias");
    const backup = { restaurantId, kind: "manual", data: { version: 1, tables: { Ingredient: [] } }, tableCounts: {}, sizeBytes: 1, expiresAt: new Date("2030-01-01") };
    await expect(db.restaurantBackup.create({ data: backup })).rejects.toThrow();
    await expect(db.restaurantBackup.create({ data: { ...backup, data: { version: 1, tables: { Ingredient: [], IngredientBarcode: [] } } } })).resolves.toMatchObject({ restaurantId });
  });
});
