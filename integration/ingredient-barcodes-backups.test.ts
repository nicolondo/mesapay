import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "../src/lib/db";
import { createBackup, restoreSnapshot, type SnapshotData } from "../src/lib/backups";

const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["127.0.0.1", "localhost"].includes(database.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname)) {
  throw new Error("Isolated local barcode validation database required");
}

const tenants: string[] = [];
let restaurantId: string;
async function tenant() {
  const row = await db.restaurant.create({ data: { name: "Barcode backup validation", slug: `barcode-backup-${randomUUID()}` } });
  tenants.push(row.id);
  return row.id;
}
const ingredient = (barcode: string | null = "000Ab", owner = restaurantId) => db.ingredient.create({
  data: { restaurantId: owner, name: randomUUID(), measureKind: "count", barcode },
});
const addCode = (ingredientId: string, barcode: string, owner = restaurantId) => db.ingredientBarcode.create({
  data: { restaurantId: owner, ingredientId, barcode },
});
const records = (owner = restaurantId) => db.ingredientBarcode.findMany({
  where: { restaurantId: owner }, orderBy: { barcode: "asc" },
});
const backup = () => createBackup({ restaurantId, kind: "manual" });
async function snapshot(id: string): Promise<SnapshotData> {
  return (await db.restaurantBackup.findUniqueOrThrow({ where: { id } })).data as unknown as SnapshotData;
}
const store = (id: string, data: SnapshotData) => db.restaurantBackup.update({
  where: { id }, data: { data: data as unknown as Prisma.InputJsonValue },
});
function withoutBarcodes(data: SnapshotData): SnapshotData {
  const tables = Object.fromEntries(Object.entries(data.tables).filter(([name]) => name !== "IngredientBarcode"));
  return { ...data, tables };
}

beforeEach(async () => { restaurantId = await tenant(); });
afterAll(async () => {
  await db.restaurant.deleteMany({ where: { id: { in: tenants } } });
  await db.$disconnect();
});

describe("ingredient barcodes in PostgreSQL backups", () => {
  it("restores every code with its original ID and leaves another tenant unchanged", async () => {
    const item = await ingredient();
    await addCode(item.id, "000ab");
    const primaryLess = await ingredient(null);
    await addCode(primaryLess.id, "ONLY-ALIAS");
    const foreignId = await tenant();
    const foreign = await ingredient("000Ab", foreignId);
    await addCode(foreign.id, "FOREIGN", foreignId);
    const original = await records();
    const foreignBefore = await records(foreignId);
    const saved = await backup();
    expect(saved.tableCounts.IngredientBarcode).toBe(3);
    expect((await snapshot(saved.id)).tables.IngredientBarcode).toEqual(
      expect.arrayContaining(original.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }))),
    );

    await db.ingredient.update({ where: { id: item.id }, data: { barcode: "LATER-PRIMARY" } });
    await addCode(item.id, "LATER-ALIAS");
    const beforeRestore = await records();
    const result = await restoreSnapshot({ restaurantId, backupId: saved.id });

    expect(result.restored.IngredientBarcode).toBe(3);
    expect(result.pruned).toEqual({});
    expect(await records()).toEqual(original);
    expect(await records(foreignId)).toEqual(foreignBefore);
    expect((await db.ingredient.findUniqueOrThrow({ where: { id: item.id } })).barcode).toBe("000Ab");
    expect((await db.ingredient.findUniqueOrThrow({ where: { id: primaryLess.id } })).barcode).toBeNull();
    expect((await snapshot(result.preRestoreBackupId)).tables.IngredientBarcode).toHaveLength(beforeRestore.length);
    const [settings] = await db.$queryRaw<{ restoring: string | null; barcodeRestore: string | null }[]>`
      SELECT current_setting('app.restoring', true) AS restoring,
        current_setting('app.ingredient_barcodes_restore', true) AS "barcodeRestore"`;
    expect(settings.restoring ?? "").toBe("");
    expect(settings.barcodeRestore ?? "").toBe("");
  });

  it("restores a pre-feature snapshot by deriving only its saved principal codes", async () => {
    const item = await ingredient();
    await ingredient(null);
    const saved = await backup();
    const data = withoutBarcodes(await snapshot(saved.id));
    await store(saved.id, data);
    await addCode(item.id, "ADDED-AFTER-SNAPSHOT");
    await db.ingredient.update({ where: { id: item.id }, data: { barcode: "CHANGED-AFTER-SNAPSHOT" } });

    const result = await restoreSnapshot({ restaurantId, backupId: saved.id });

    expect(result.restored.IngredientBarcode).toBe(1);
    expect(await records()).toEqual([expect.objectContaining({ ingredientId: item.id, barcode: "000Ab" })]);
    expect((await db.ingredient.findUniqueOrThrow({ where: { id: item.id } })).barcode).toBe("000Ab");
    expect((await snapshot(saved.id)).tables).not.toHaveProperty("IngredientBarcode");
    expect((await snapshot(result.preRestoreBackupId)).tables.IngredientBarcode).toHaveLength(2);
  });

  it("repairs a missing primary registry entry while preserving backed-up additional codes", async () => {
    const item = await ingredient();
    const alias = await addCode(item.id, "ADDITIONAL");
    const saved = await backup();
    const data = await snapshot(saved.id);
    await store(saved.id, { ...data, tables: { ...data.tables, IngredientBarcode: data.tables.IngredientBarcode.filter((row) => row.id === alias.id) } });

    const result = await restoreSnapshot({ restaurantId, backupId: saved.id });

    expect(result.restored.IngredientBarcode).toBe(2);
    expect(await records()).toEqual([
      expect.objectContaining({ ingredientId: item.id, barcode: "000Ab" }),
      alias,
    ]);
  });

  it("prunes both forms of cross-tenant snapshot references without touching the foreign product", async () => {
    const item = await ingredient();
    const foreignId = await tenant();
    const foreign = await ingredient("FOREIGN", foreignId);
    const foreignBefore = await records(foreignId);
    const saved = await backup();
    const data = await snapshot(saved.id);
    const badRows = [
      { id: randomUUID(), restaurantId, ingredientId: foreign.id, barcode: "BAD-PARENT", createdAt: data.takenAt },
      { id: randomUUID(), restaurantId: foreignId, ingredientId: item.id, barcode: "BAD-TENANT", createdAt: data.takenAt },
    ];
    await store(saved.id, { ...data, tables: { ...data.tables, IngredientBarcode: [...data.tables.IngredientBarcode, ...badRows] } });

    const result = await restoreSnapshot({ restaurantId, backupId: saved.id });

    expect(result.pruned.IngredientBarcode).toBe(2);
    expect(result.restored.IngredientBarcode).toBe(1);
    expect(await records()).toEqual([expect.objectContaining({ ingredientId: item.id, barcode: "000Ab" })]);
    expect(await records(foreignId)).toEqual(foreignBefore);
  });

  it("fails before pre-restore backup when a primary code is claimed by another product", async () => {
    const item = await ingredient();
    const other = await ingredient(null);
    const saved = await backup();
    const data = await snapshot(saved.id);
    await store(saved.id, { ...data, tables: { ...data.tables, IngredientBarcode: data.tables.IngredientBarcode.map((row) => ({ ...row, ingredientId: other.id })) } });
    const before = await records();

    await expect(restoreSnapshot({ restaurantId, backupId: saved.id })).rejects.toMatchObject({ code: "backup_version_unsupported" });

    expect(await records()).toEqual(before);
    expect(await db.restaurantBackup.count({ where: { restaurantId, kind: "pre_restore" } })).toBe(0);
    expect((await db.ingredient.findUniqueOrThrow({ where: { id: item.id } })).barcode).toBe("000Ab");
  });
});

describe("legacy binary backup and restore protection", () => {
  it.each(["insert", "update", "delete"] as const)("rejects legacy restore %s and rolls its transaction back", async (operation) => {
    const item = await ingredient();
    await addCode(item.id, "PRESERVE-ALIAS");
    const before = await records();

    await expect(db.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL app.restoring = '1'`;
      if (operation === "insert") await tx.ingredient.create({ data: { restaurantId, name: randomUUID(), measureKind: "count" } });
      if (operation === "update") await tx.ingredient.update({ where: { id: item.id }, data: { barcode: "LEGACY" } });
      if (operation === "delete") await tx.ingredient.delete({ where: { id: item.id } });
    })).rejects.toThrow(/ingredient_barcodes_restore_requires_current_release/);

    expect(await records()).toEqual(before);
    expect(await db.ingredient.count({ where: { restaurantId } })).toBe(1);
    expect((await db.ingredient.findUniqueOrThrow({ where: { id: item.id } })).barcode).toBe("000Ab");
  });

  it("does not bypass normal primary-code sync with the barcode marker alone", async () => {
    const item = await ingredient();
    await addCode(item.id, "PRESERVE-ALIAS");
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL app.ingredient_barcodes_restore = '1'`;
      await tx.ingredient.update({ where: { id: item.id }, data: { barcode: "NEW-PRIMARY" } });
    });
    expect((await records()).map((row) => row.barcode)).toEqual(["NEW-PRIMARY", "PRESERVE-ALIAS"]);
  });

  it("rejects a legacy backup writer once additional codes exist, including payload replacement", async () => {
    const item = await ingredient();
    const saved = await backup();
    const legacy = withoutBarcodes(await snapshot(saved.id));
    await addCode(item.id, "PRESERVE-ALIAS");

    await expect(db.restaurantBackup.create({ data: {
      restaurantId, kind: "manual", sizeBytes: 1, tableCounts: {}, expiresAt: new Date(Date.now() + 60_000),
      data: legacy as unknown as Prisma.InputJsonValue,
    } })).rejects.toThrow(/ingredient_barcodes_backup_requires_current_release/);
    await expect(store(saved.id, legacy)).rejects.toThrow(/ingredient_barcodes_backup_requires_current_release/);

    expect(await db.restaurantBackup.count({ where: { restaurantId } })).toBe(1);
    expect((await snapshot(saved.id)).tables.IngredientBarcode).toHaveLength(1);
    expect((await records()).map((row) => row.barcode)).toEqual(["000Ab", "PRESERVE-ALIAS"]);
  });
});
