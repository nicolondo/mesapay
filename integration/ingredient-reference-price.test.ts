import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { applyStockMovement } from "../src/lib/erp/stock";
import { lockStock } from "../src/lib/orderLock";
import { createPurchaseOrder, receivePurchaseOrder } from "../src/lib/erp/purchasing";
import { runProduction } from "../src/lib/erp/production";
import { loadCostContext } from "../src/lib/erp/recipeData";
import { resolveIngredientCost } from "../src/lib/erp/recipes";
import { POST as createIngredient } from "../src/app/api/operator/ingredients/route";
import { PATCH as updateIngredient } from "../src/app/api/operator/ingredients/[id]/route";
import { POST as bulkIngredients } from "../src/app/api/operator/ingredients/bulk/route";

const scope = vi.hoisted(() => ({ restaurantId: "" }));
vi.mock("../src/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("../src/lib/erp/access", () => ({
  getErpContext: async () => ({ restaurantId: scope.restaurantId, userId: null }),
  isDenied: () => false,
}));
vi.mock("../src/auth", () => ({ auth: async () => ({ user: { id: "price-validation-actor", email: "price-validation@example.invalid", role: "operator" } }) }));

const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["127.0.0.1", "localhost"].includes(database.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname)) {
  throw new Error("Isolated local database required");
}

const tenants: string[] = [];
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const request = (payload: unknown) => new Request("http://localhost/api/operator/ingredients", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
});
const edit = (id: string, body: unknown) => updateIngredient(request(body), params(id));
const makeIngredient = async (overrides: Record<string, unknown> = {}) => {
  const response = await createIngredient(request({ name: `Price ingredient ${randomUUID()}`, measureKind: "mass", ...overrides }));
  expect(response.status).toBe(201);
  return (await response.json()).ingredient as { id: string; referencePriceCents: number | null };
};

beforeEach(async () => {
  const restaurant = await db.restaurant.create({ data: {
    name: "Ingredient reference validation", slug: `ingredient-price-${randomUUID()}`,
    enabledModules: ["inventory", "purchasing", "recipes", "production"],
  } });
  scope.restaurantId = restaurant.id;
  tenants.push(restaurant.id);
});

afterAll(async () => {
  await db.auditEvent.deleteMany({ where: { restaurantId: { in: tenants } } });
  await db.productionBatch.deleteMany({ where: { restaurantId: { in: tenants } } });
  await db.purchaseOrder.deleteMany({ where: { restaurantId: { in: tenants } } });
  await db.recipe.deleteMany({ where: { restaurantId: { in: tenants } } });
  await db.restaurant.deleteMany({ where: { id: { in: tenants } } });
  await db.$disconnect();
});

describe("reference prices persisted independently of inventory valuation", () => {
  it("creates, edits, clears and resolves an untracked ingredient without a supplier", async () => {
    const ingredient = await makeIngredient({ trackInventory: false, measureKind: "count", referencePriceCents: 1999 });
    expect((await loadCostContext(scope.restaurantId)).ctx.get(ingredient.id)).toMatchObject({ referencePriceCents: 1999 });
    expect(resolveIngredientCost((await loadCostContext(scope.restaurantId)).ctx, ingredient.id)).toEqual({ costPerBase: 1.999, source: "reference" });
    expect((await edit(ingredient.id, { referencePriceCents: 0 })).status).toBe(200);
    expect(resolveIngredientCost((await loadCostContext(scope.restaurantId)).ctx, ingredient.id)).toEqual({ costPerBase: 0, source: "reference" });
    expect((await edit(ingredient.id, { notes: "Ordinary edit" })).status).toBe(200);
    expect((await db.ingredient.findUniqueOrThrow({ where: { id: ingredient.id } })).referencePriceCents).toBe(0);
    expect((await edit(ingredient.id, { referencePriceCents: null })).status).toBe(200);
    expect(resolveIngredientCost((await loadCostContext(scope.restaurantId)).ctx, ingredient.id)).toBeNull();
    expect(await db.stockLevel.count({ where: { ingredientId: ingredient.id } })).toBe(0);
    expect(await db.stockMovement.count({ where: { ingredientId: ingredient.id } })).toBe(0);
    expect(await db.supplierIngredient.count({ where: { ingredientId: ingredient.id } })).toBe(0);
    expect(await db.auditEvent.findMany({ where: { restaurantId: scope.restaurantId, kind: "ingredient.reference_price.update" } })).toHaveLength(3);
  });

  it("preserves every stock, purchase, supplier-price and production record when changing the reference", async () => {
    const ingredient = await makeIngredient({ referencePriceCents: 100000 });
    const restaurantId = scope.restaurantId;
    const supplier = await db.supplier.create({ data: { restaurantId, name: "Historical supplier" } });
    const presentation = await db.supplierIngredient.create({ data: { supplierId: supplier.id, ingredientId: ingredient.id, presentationLabel: "Bag 1 kg", contentQty: 1000, lastPriceCents: 100000, preferred: true } });
    const purchase = await db.$transaction((tx) => createPurchaseOrder(tx, { restaurantId, supplierId: supplier.id, lines: [{ ingredientId: ingredient.id, supplierItemId: presentation.id, presentations: 2, qtyBase: 2000, expectedCostCents: 240000 }] }));
    await db.$transaction((tx) => receivePurchaseOrder(tx, { restaurantId, purchaseOrderId: purchase.id, lines: [{ itemId: purchase.items[0].id, qtyBase: 2000, costCents: 240000 }] }));
    const output = await db.ingredient.create({ data: { restaurantId, name: "Historical prepared ingredient", measureKind: "mass", recipe: { create: { restaurantId, outputQtyBase: 1000, items: { create: { ingredientId: ingredient.id, qtyBase: 500 } } } } } });
    await db.$transaction((tx) => runProduction(tx, { restaurantId, outputIngredientId: output.id, outputQtyBase: 1000 }));
    const snapshot = async () => ({
      levels: await db.stockLevel.findMany({ where: { restaurantId }, orderBy: { id: "asc" } }),
      movements: await db.stockMovement.findMany({ where: { restaurantId }, orderBy: { id: "asc" } }),
      purchases: await db.purchaseOrder.findMany({ where: { restaurantId }, include: { items: true } }),
      supplierItems: await db.supplierIngredient.findMany({ where: { supplierId: supplier.id }, include: { priceHistory: true } }),
      batches: await db.productionBatch.findMany({ where: { restaurantId } }),
    });
    const before = await snapshot();

    expect((await edit(ingredient.id, { referencePriceCents: 950000 })).status).toBe(200);

    expect(await snapshot()).toEqual(before);
    expect(resolveIngredientCost((await loadCostContext(restaurantId)).ctx, ingredient.id)).toEqual({ costPerBase: 120, source: "stock" });
    expect(await db.auditEvent.findFirst({ where: { restaurantId, kind: "ingredient.reference_price.update", targetId: ingredient.id }, orderBy: { occurredAt: "desc" } })).toMatchObject({
      actorEmail: "price-validation@example.invalid", actorRole: "operator",
      diff: { before: { referencePriceCents: 100000, measureKind: "mass" }, after: { referencePriceCents: 950000, measureKind: "mass" } },
    });
  });

  it("preserves references on unchanged dimensions and clears them when changing dimension", async () => {
    const ingredient = await makeIngredient({ referencePriceCents: 12000 });
    expect((await edit(ingredient.id, { measureKind: "mass" })).status).toBe(200);
    expect((await db.ingredient.findUniqueOrThrow({ where: { id: ingredient.id } })).referencePriceCents).toBe(12000);
    expect((await edit(ingredient.id, { measureKind: "volume" })).status).toBe(200);
    expect(await db.ingredient.findUniqueOrThrow({ where: { id: ingredient.id } })).toMatchObject({ measureKind: "volume", referencePriceCents: null });
    expect((await edit(ingredient.id, { measureKind: "count", referencePriceCents: 9900 })).status).toBe(200);
    expect(await db.ingredient.findUniqueOrThrow({ where: { id: ingredient.id } })).toMatchObject({ measureKind: "count", referencePriceCents: 9900 });
  });

  it("keeps dimension locks on ingredients with valued stock", async () => {
    const ingredient = await makeIngredient({ referencePriceCents: 100000 });
    await db.$transaction((tx) => applyStockMovement(tx, { restaurantId: scope.restaurantId, ingredientId: ingredient.id, kind: "purchase_in", qtyBase: 1000, totalCostCents: 120000 }));
    expect((await edit(ingredient.id, { measureKind: "volume", referencePriceCents: 500000 })).status).toBe(409);
    expect(await db.ingredient.findUniqueOrThrow({ where: { id: ingredient.id } })).toMatchObject({ measureKind: "mass", referencePriceCents: 100000 });
  });

  it("clears only genuinely changed dimensions in bulk and preserves foreign ingredients", async () => {
    const first = await makeIngredient({ referencePriceCents: 100000 });
    const second = await makeIngredient({ measureKind: "volume", referencePriceCents: 200000 });
    const foreign = await db.restaurant.create({ data: { name: "Other price scope", slug: `price-foreign-${randomUUID()}` } });
    tenants.push(foreign.id);
    const foreignIngredient = await db.ingredient.create({ data: { restaurantId: foreign.id, name: "Foreign", measureKind: "mass", referencePriceCents: 330000 } });
    const response = await bulkIngredients(request({ action: "measureKind", ids: [first.id, second.id, foreignIngredient.id], measureKind: "volume" }));
    expect(response.status).toBe(200);
    expect(await db.ingredient.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ measureKind: "volume", referencePriceCents: null });
    expect(await db.ingredient.findUniqueOrThrow({ where: { id: second.id } })).toMatchObject({ measureKind: "volume", referencePriceCents: 200000 });
    expect(await db.ingredient.findUniqueOrThrow({ where: { id: foreignIngredient.id } })).toMatchObject({ measureKind: "mass", referencePriceCents: 330000 });
    expect((await edit(foreignIngredient.id, { referencePriceCents: 0 })).status).toBe(404);
  });

  it("defaults historical ingredients to null and enforces the database price bounds", async () => {
    const ingredient = await db.ingredient.create({ data: { restaurantId: scope.restaurantId, name: "Legacy without reference", measureKind: "volume" } });
    expect(ingredient.referencePriceCents).toBeNull();
    await expect(db.ingredient.update({ where: { id: ingredient.id }, data: { referencePriceCents: -1 } })).rejects.toThrow();
    await expect(db.ingredient.update({ where: { id: ingredient.id }, data: { referencePriceCents: 2_000_000_001 } })).rejects.toThrow();
    expect((await db.ingredient.findUniqueOrThrow({ where: { id: ingredient.id } })).referencePriceCents).toBeNull();
  });

  it("skips bulk dimension changes with stock balances, stock history or supplier references", async () => {
    const restaurantId = scope.restaurantId;
    const balanceRows = await Promise.all([
      { qtyBase: 1000, totalValueCents: 120000 },
      { qtyBase: 1000, totalValueCents: 0 },
      { qtyBase: 0, totalValueCents: 120000 },
      { qtyBase: -1000, totalValueCents: -120000 },
    ].map(async (balance) => {
      const ingredient = await makeIngredient({ referencePriceCents: 100000 });
      await db.stockLevel.create({ data: { restaurantId, ingredientId: ingredient.id, ...balance } });
      return ingredient;
    }));
    const historical = await makeIngredient({ referencePriceCents: 110000 });
    await db.$transaction(async (tx) => {
      await applyStockMovement(tx, { restaurantId, ingredientId: historical.id, kind: "purchase_in", qtyBase: 1000, totalCostCents: 120000 });
      await applyStockMovement(tx, { restaurantId, ingredientId: historical.id, kind: "adjust_out", qtyBase: 1000 });
    });
    const supplied = await makeIngredient({ referencePriceCents: 130000 });
    const supplier = await db.supplier.create({ data: { restaurantId, name: "Bulk reference supplier" } });
    await db.supplierIngredient.create({ data: { supplierId: supplier.id, ingredientId: supplied.id, presentationLabel: "Bag", contentQty: 1000, lastPriceCents: 130000 } });
    const eligible = await makeIngredient({ referencePriceCents: 140000 });
    await db.stockLevel.create({ data: { restaurantId, ingredientId: eligible.id, qtyBase: 0, totalValueCents: 0 } });
    const blockedIds = [...balanceRows.map((item) => item.id), historical.id, supplied.id];
    const snapshot = async () => ({
      ingredients: await db.ingredient.findMany({ where: { id: { in: blockedIds } }, orderBy: { id: "asc" } }),
      levels: await db.stockLevel.findMany({ where: { restaurantId }, orderBy: { id: "asc" } }),
      movements: await db.stockMovement.findMany({ where: { restaurantId }, orderBy: { id: "asc" } }),
    });
    const before = await snapshot();

    const response = await bulkIngredients(request({ action: "measureKind", ids: [...blockedIds, eligible.id], measureKind: "volume" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ updated: 1, skipped: blockedIds.length, changedIds: [eligible.id] });
    expect(await snapshot()).toEqual(before);
    expect(await db.ingredient.findUniqueOrThrow({ where: { id: eligible.id } })).toMatchObject({ measureKind: "volume", referencePriceCents: null });
  });

  it("allows bulk same-dimension requests without clearing price or altering existing references", async () => {
    const restaurantId = scope.restaurantId;
    const ingredient = await makeIngredient({ referencePriceCents: 150000 });
    await db.$transaction((tx) => applyStockMovement(tx, { restaurantId, ingredientId: ingredient.id, kind: "purchase_in", qtyBase: 1000, totalCostCents: 130000 }));
    const supplier = await db.supplier.create({ data: { restaurantId, name: "Same-dimension supplier" } });
    await db.supplierIngredient.create({ data: { supplierId: supplier.id, ingredientId: ingredient.id, presentationLabel: "Bag", contentQty: 1000 } });
    const before = await db.ingredient.findUniqueOrThrow({ where: { id: ingredient.id }, include: { stockLevel: true, stockMovements: true, supplierItems: true } });
    const auditCount = await db.auditEvent.count({ where: { restaurantId } });

    const response = await bulkIngredients(request({ action: "measureKind", ids: [ingredient.id], measureKind: "mass" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ updated: 1, skipped: 0, changedIds: [ingredient.id] });
    expect(await db.ingredient.findUniqueOrThrow({ where: { id: ingredient.id }, include: { stockLevel: true, stockMovements: true, supplierItems: true } })).toEqual(before);
    expect(await db.auditEvent.count({ where: { restaurantId } })).toBe(auditCount);
  });

  it("checks new stock written by a concurrent transaction before changing a dimension in bulk", async () => {
    const restaurantId = scope.restaurantId;
    const ingredient = await makeIngredient({ referencePriceCents: 160000 });
    let releaseStock!: () => void;
    let reportLocked!: () => void;
    const release = new Promise<void>((resolve) => { releaseStock = resolve; });
    const locked = new Promise<void>((resolve) => { reportLocked = resolve; });
    const reception = db.$transaction(async (tx) => {
      await lockStock(tx, restaurantId);
      await applyStockMovement(tx, { restaurantId, ingredientId: ingredient.id, kind: "purchase_in", qtyBase: 1000, totalCostCents: 150000 });
      reportLocked();
      await release;
    });
    await locked;
    const changing = bulkIngredients(request({ action: "measureKind", ids: [ingredient.id], measureKind: "volume" }));
    let state: string;
    try {
      state = await Promise.race([changing.then(() => "finished"), new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 100))]);
    } finally {
      releaseStock();
    }
    await reception;
    const response = await changing;

    expect(state).toBe("waiting");
    expect(await response.json()).toEqual({ updated: 0, skipped: 1, changedIds: [] });
    expect(await db.ingredient.findUniqueOrThrow({ where: { id: ingredient.id } })).toMatchObject({ measureKind: "mass", referencePriceCents: 160000 });
    expect(await db.stockLevel.findUniqueOrThrow({ where: { ingredientId: ingredient.id } })).toMatchObject({ qtyBase: 1000, totalValueCents: 150000 });
    expect(await db.stockMovement.count({ where: { ingredientId: ingredient.id } })).toBe(1);
  });

  it("preserves reference prices when bulk categories are assigned, renamed or left unchanged", async () => {
    const first = await makeIngredient({ category: "Before", referencePriceCents: 170000 });
    const second = await makeIngredient({ category: "Before", measureKind: "count", referencePriceCents: 0 });
    const ids = [first.id, second.id];
    const read = () => db.ingredient.findMany({ where: { id: { in: ids } }, orderBy: { id: "asc" }, select: { id: true, category: true, measureKind: true, referencePriceCents: true } });
    const original = await read();
    const initialAuditCount = await db.auditEvent.count({ where: { restaurantId: scope.restaurantId } });

    expect((await bulkIngredients(request({ action: "category", ids, category: "Assigned" }))).status).toBe(200);
    expect(await read()).toEqual(original.map((item) => ({ ...item, category: "Assigned" })));
    expect((await bulkIngredients(request({ action: "renameCategory", from: "Assigned", to: "Renamed" }))).status).toBe(200);
    expect(await read()).toEqual(original.map((item) => ({ ...item, category: "Renamed" })));
    const unchanged = await bulkIngredients(request({ action: "renameCategory", from: "Renamed", to: "Renamed" }));
    expect((await unchanged.json()).updated).toBe(0);
    expect(await read()).toEqual(original.map((item) => ({ ...item, category: "Renamed" })));
    expect(await db.auditEvent.count({ where: { restaurantId: scope.restaurantId } })).toBe(initialAuditCount);
  });

  it("rejects an invalid bulk request or foreign-only selection without clearing reference prices", async () => {
    const ingredient = await makeIngredient({ referencePriceCents: 180000 });
    const original = await db.ingredient.findUniqueOrThrow({ where: { id: ingredient.id } });
    expect((await bulkIngredients(request({ action: "measureKind", ids: [ingredient.id], measureKind: "invalid" }))).status).toBe(400);
    expect((await bulkIngredients(request({ action: "measureKind", ids: [], measureKind: "volume" }))).status).toBe(400);
    expect((await bulkIngredients(request({ action: "measureKind", ids: ["foreign-or-missing"], measureKind: "volume" }))).status).toBe(404);
    expect(await db.ingredient.findUniqueOrThrow({ where: { id: ingredient.id } })).toEqual(original);
  });
});
