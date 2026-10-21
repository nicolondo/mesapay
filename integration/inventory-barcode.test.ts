import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { mutateStockCount } from "../src/lib/erp/stockCounts";
import { POST as addBarcode } from "../src/app/api/operator/ingredients/[id]/barcode/route";
import { POST as createCount } from "../src/app/api/operator/stock/counts/route";

const scope = vi.hoisted(() => ({ restaurantId: "" }));
vi.mock("../src/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("../src/lib/activeRestaurant", () => ({ getActiveRestaurantId: async () => scope.restaurantId }));
vi.mock("../src/auth", () => ({ auth: async () => ({ user: { email: "barcode-validation@example.invalid", role: "operator" } }) }));

const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["127.0.0.1", "localhost"].includes(database.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname)) {
  throw new Error("Isolated local barcode validation database required");
}

type BarcodeIngredient = { id: string; barcode: string | null; barcodes: { barcode: string }[] };
type Count = { id: string; revision: number; finalReview: { token: string } | null; items: { id: string; ingredientId: string }[] };
const tenants: string[] = [];
const request = (body: unknown) => new Request("http://localhost/api/operator/ingredients/unused/barcode", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const add = (id: string, barcode: string) => addBarcode(request({ barcode }), { params: Promise.resolve({ id }) });
const ingredient = (overrides: { barcode?: string | null; active?: boolean; trackInventory?: boolean; restaurantId?: string } = {}) => db.ingredient.create({
  data: { restaurantId: scope.restaurantId, name: randomUUID(), measureKind: "count", referencePriceCents: 12345, ...overrides },
});
const read = (id: string) => db.ingredient.findUniqueOrThrow({
  where: { id }, select: { id: true, barcode: true, barcodes: { select: { barcode: true }, orderBy: { barcode: "asc" } } },
});
const codes = (item: BarcodeIngredient) => item.barcodes.map((row) => row.barcode).sort();
const audits = (id: string) => db.auditEvent.findMany({ where: { targetId: id, kind: "ingredient.barcode.add" } });
async function success(response: Response) {
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body.ingredient as BarcodeIngredient;
}
async function startCount(): Promise<Count> {
  const response = await createCount(request({}));
  expect(response.status).toBe(201);
  return (await response.json()).count as Count;
}
async function countAction(count: Count, action: "save" | "preliminary" | "recount" | "review", items?: { itemId: string; countedQty: number }[]): Promise<Count> {
  const result = await mutateStockCount(scope.restaurantId, count.id, action, { revision: count.revision, items });
  if (!("count" in result)) throw new Error("Expected a stock count");
  return result.count as unknown as Count;
}

beforeEach(async () => {
  const tenant = await db.restaurant.create({ data: { name: "Barcode validation", slug: "barcode-" + randomUUID(), enabledModules: ["inventory"] } });
  scope.restaurantId = tenant.id;
  tenants.push(tenant.id);
});
afterAll(async () => {
  await db.auditEvent.deleteMany({ where: { restaurantId: { in: tenants } } });
  await db.restaurant.deleteMany({ where: { id: { in: tenants } } });
  await db.$disconnect();
});

describe("multiple inventory barcodes on PostgreSQL", () => {
  it("adds a first code and additional codes without changing the primary, prices or stock", async () => {
    const item = await ingredient();
    await db.stockLevel.create({ data: { restaurantId: scope.restaurantId, ingredientId: item.id, qtyBase: 7000, totalValueCents: 12000 } });
    const initial = await db.ingredient.findUniqueOrThrow({ where: { id: item.id }, include: { stockLevel: true, stockMovements: true } });
    expect(await success(await add(item.id, " \t00 123ab\r\n"))).toEqual({ id: item.id, barcode: "00123ab", barcodes: [{ barcode: "00123ab" }] });
    const second = await success(await add(item.id, "00999X"));
    expect(second.barcode).toBe("00123ab");
    expect(codes(second)).toEqual(["00123ab", "00999X"]);
    const after = await db.ingredient.findUniqueOrThrow({ where: { id: item.id }, include: { stockLevel: true, stockMovements: true } });
    expect({ ...after, barcode: initial.barcode, updatedAt: initial.updatedAt }).toEqual(initial);
    expect(await audits(item.id)).toHaveLength(2);
  });

  it("makes existing primary and additional codes idempotent, preserving case and zeroes", async () => {
    const item = await ingredient({ barcode: "000Ab" });
    expect(codes(await read(item.id))).toEqual(["000Ab"]);
    await success(await add(item.id, "000ab"));
    await success(await add(item.id, " 000Ab\r\n"));
    await success(await add(item.id, "000ab"));
    const persisted = await read(item.id);
    expect(persisted).toMatchObject({ id: item.id, barcode: "000Ab" });
    // PostgreSQL collations order upper/lower case differently across hosts.
    expect(codes(persisted)).toEqual(["000Ab", "000ab"]);
    expect(await audits(item.id)).toHaveLength(1);
  });

  it("refuses primary and additional codes owned by another ingredient in the same tenant", async () => {
    const owner = await ingredient({ barcode: "PRIMARY" });
    await success(await add(owner.id, "ALIAS"));
    const target = await ingredient();
    for (const barcode of ["PRIMARY", "ALIAS"]) {
      const response = await add(target.id, barcode);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "barcode_taken" });
    }
    expect(await read(target.id)).toEqual({ id: target.id, barcode: null, barcodes: [] });
    expect(await audits(target.id)).toHaveLength(0);
  });

  it("isolates both ownership and barcode uniqueness by tenant", async () => {
    const own = await ingredient({ barcode: "SHARED" });
    const foreign = await db.restaurant.create({ data: { name: "Foreign barcode validation", slug: "barcode-foreign-" + randomUUID(), enabledModules: ["inventory"] } });
    tenants.push(foreign.id);
    const other = await ingredient({ restaurantId: foreign.id });
    const denied = await add(other.id, "FOREIGN");
    expect(denied.status).toBe(404);
    expect(await denied.json()).toEqual({ error: "not_found" });
    scope.restaurantId = foreign.id;
    await success(await add(other.id, "SHARED"));
    expect((await read(own.id)).barcode).toBe("SHARED");
    expect((await read(other.id)).barcode).toBe("SHARED");
  });

  it.each([{ active: false }, { trackInventory: false }])("rejects unavailable inventory items: %j", async (state) => {
    const item = await ingredient(state);
    expect((await add(item.id, "CODE")).status).toBe(409);
    expect((await read(item.id)).barcodes).toEqual([]);
    expect(await audits(item.id)).toHaveLength(0);
  });

  it("enforces the real inventory module gate", async () => {
    const item = await ingredient();
    await db.restaurant.update({ where: { id: scope.restaurantId }, data: { enabledModules: ["purchasing", "recipes"] } });
    const response = await add(item.id, "CODE");
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "module_disabled" });
    expect((await read(item.id)).barcodes).toEqual([]);
  });

  it("serializes two different first codes without replacing either one", async () => {
    const item = await ingredient();
    const responses = await Promise.all([add(item.id, "FIRST"), add(item.id, "SECOND")]);
    for (const response of responses) await success(response);
    const persisted = await read(item.id);
    expect(["FIRST", "SECOND"]).toContain(persisted.barcode);
    expect(codes(persisted)).toEqual(["FIRST", "SECOND"]);
    expect(await audits(item.id)).toHaveLength(2);
  });

  it("makes simultaneous retries create one barcode and one audit event", async () => {
    const item = await ingredient();
    const responses = await Promise.all([add(item.id, "SAME"), add(item.id, "SAME")]);
    for (const response of responses) await success(response);
    expect(codes(await read(item.id))).toEqual(["SAME"]);
    expect(await audits(item.id)).toHaveLength(1);
  });

  it("lets only one ingredient claim the same barcode concurrently", async () => {
    const first = await ingredient({ barcode: "FIRST" });
    const second = await ingredient({ barcode: "SECOND" });
    const responses = await Promise.all([add(first.id, "SHARED"), add(second.id, "SHARED")]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(await responses.find((response) => response.status === 409)!.json()).toEqual({ error: "barcode_taken" });
    expect(await db.ingredientBarcode.count({ where: { restaurantId: scope.restaurantId, barcode: "SHARED" } })).toBe(1);
    expect((await read(first.id)).barcode).toBe("FIRST");
    expect((await read(second.id)).barcode).toBe("SECOND");
    expect((await audits(first.id)).length + (await audits(second.id)).length).toBe(1);
  });

  it("keeps canonical codes in sync with legacy primary edits and protects additional codes", async () => {
    const owner = await ingredient({ barcode: "OLD" });
    await success(await add(owner.id, "ALIAS"));
    await success(await add(owner.id, "OTHER"));
    await db.ingredient.update({ where: { id: owner.id }, data: { barcode: "ALIAS" } });
    expect(codes(await read(owner.id))).toEqual(["ALIAS", "OTHER"]);
    const target = await ingredient({ barcode: "TARGET" });
    await expect(db.ingredient.update({ where: { id: target.id }, data: { barcode: "OTHER" } })).rejects.toMatchObject({ code: "P2002" });
    expect((await read(target.id)).barcode).toBe("TARGET");
    await db.ingredient.update({ where: { id: owner.id }, data: { barcode: null } });
    expect(codes(await read(owner.id))).toEqual(["OTHER"]);
    const auditCount = (await audits(owner.id)).length;
    const promoted = await success(await add(owner.id, "OTHER"));
    expect(promoted.barcode).toBe("OTHER");
    expect(codes(promoted)).toEqual(["OTHER"]);
    expect(await audits(owner.id)).toHaveLength(auditCount);
  });

  it("preserves saved counts, review tokens and stock when assigning an additional code", async () => {
    const item = await ingredient({ barcode: "PRIMARY" });
    await db.stockLevel.create({ data: { restaurantId: scope.restaurantId, ingredientId: item.id, qtyBase: 7000, totalValueCents: 12000 } });
    let count = await startCount();
    const counted = [{ itemId: count.items[0].id, countedQty: 6250 }];
    count = await countAction(count, "save", counted);
    count = await countAction(count, "preliminary");
    count = await countAction(count, "recount");
    count = await countAction(count, "save", counted);
    count = await countAction(count, "review");
    const snapshot = async () => ({
      count: await db.stockCount.findUniqueOrThrow({ where: { id: count.id }, include: { items: true } }),
      stock: await db.stockLevel.findUniqueOrThrow({ where: { ingredientId: item.id } }),
      movements: await db.stockMovement.findMany({ where: { restaurantId: scope.restaurantId } }),
    });
    const before = await snapshot();
    await success(await add(item.id, "ALIAS"));
    expect(await snapshot()).toEqual(before);
    const closed = await mutateStockCount(scope.restaurantId, count.id, "close", { revision: count.revision, reviewToken: count.finalReview!.token });
    expect("count" in closed && closed.count.status).toBe("closed");
    expect((await db.stockLevel.findUniqueOrThrow({ where: { ingredientId: item.id } })).qtyBase).toBe(6250);
  });

  it("serializes a barcode addition with count saving without losing quantities or revision", async () => {
    const item = await ingredient({ barcode: "PRIMARY" });
    const count = await startCount();
    const [barcodeResponse, saved] = await Promise.all([
      add(item.id, "ALIAS"),
      countAction(count, "save", [{ itemId: count.items[0].id, countedQty: 5250 }]),
    ]);
    await success(barcodeResponse);
    const persisted = await db.stockCount.findUniqueOrThrow({ where: { id: count.id }, include: { items: true } });
    expect(persisted.revision).toBe(saved.revision);
    expect(persisted.revision).toBe(count.revision + 1);
    expect(persisted.items[0].countedQty).toBe(5250);
    expect(codes(await read(item.id))).toEqual(["ALIAS", "PRIMARY"]);
    expect(await db.stockMovement.count({ where: { restaurantId: scope.restaurantId } })).toBe(0);
  });
});
