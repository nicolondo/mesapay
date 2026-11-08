import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Prisma, PurchaseOrderStatus } from "@prisma/client";
import { db } from "../src/lib/db";
import { createPurchaseOrder, receivePurchaseOrder } from "../src/lib/erp/purchasing";
import { applyStockMovement } from "../src/lib/erp/stock";
import { loadPurchaseCosts } from "../src/lib/erp/purchaseCostData";
import { loadCostContext } from "../src/lib/erp/recipeData";
import { costRecipeItems, resolveIngredientCost } from "../src/lib/erp/recipes";
import { POST as confirmInvoice } from "../src/app/api/operator/purchase-invoices/[id]/confirm/route";
import { GET as getIngredients, POST as createIngredientRoute } from "../src/app/api/operator/ingredients/route";
import { PATCH as editIngredient } from "../src/app/api/operator/ingredients/[id]/route";

const scope = vi.hoisted(() => ({ restaurantId: "" }));
vi.mock("../src/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("../src/lib/erp/access", () => ({ getErpContext: async () => ({ restaurantId: scope.restaurantId, userId: null }), isDenied: () => false }));
vi.mock("../src/auth", () => ({ auth: async () => ({ user: { role: "operator" } }) }));

const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["127.0.0.1", "localhost"].includes(database.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname)) {
  throw new Error("Isolated local database required");
}

const tenants: string[] = [];
let supplierId: string;
let number = 0;
const date = (day: string) => new Date(`${day}T12:00:00.000Z`);
const request = (body: unknown) => new Request("http://localhost/api/operator/ingredients", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(async () => {
  const restaurant = await db.restaurant.create({ data: {
    name: "Purchase cost validation", slug: `purchase-cost-${randomUUID()}`,
    enabledModules: ["inventory", "purchasing", "recipes"], purchaseIvaDeductible: false,
  } });
  tenants.push(restaurant.id);
  scope.restaurantId = restaurant.id;
  supplierId = (await db.supplier.create({ data: { restaurantId: restaurant.id, name: "Fixture supplier" } })).id;
});

afterAll(async () => {
  await db.auditEvent.deleteMany({ where: { restaurantId: { in: tenants } } });
  await db.purchaseOrder.deleteMany({ where: { restaurantId: { in: tenants } } });
  await db.recipe.deleteMany({ where: { restaurantId: { in: tenants } } });
  await db.restaurant.deleteMany({ where: { id: { in: tenants } } });
  await db.$disconnect();
});

const ingredient = (trackInventory = false, restaurantId = scope.restaurantId) => db.ingredient.create({ data: {
  restaurantId, name: `Ingredient ${randomUUID()}`, measureKind: "mass", trackInventory,
} });
const legacyLine = (ingredientId: string, extra: Partial<Prisma.PurchaseOrderItemUncheckedCreateWithoutPurchaseOrderInput> = {}) => ({
  ingredientId, qtyOrderedBase: 2000, receivedQtyBase: 2000,
  expectedCostCents: 1000000, receivedCostCents: 1000000,
  nonInventoryReceivedCostCents: 1000000, ...extra,
});
const legacy = (items: Prisma.PurchaseOrderItemUncheckedCreateWithoutPurchaseOrderInput[], extra: {
  status?: PurchaseOrderStatus; createdAt?: Date; receivedAt?: Date | null;
} = {}) => db.purchaseOrder.create({ data: {
  restaurantId: scope.restaurantId, supplierId, number: ++number, status: "received",
  createdAt: date("2026-10-01"), receivedAt: date("2026-10-05"), ...extra,
  items: { create: items },
}, include: { items: true } });
const effective = async (id: string) => resolveIngredientCost((await loadCostContext(scope.restaurantId)).ctx, id);
const receipt = async (ingredientId: string, net = 1000000, qty = 2000, deductible = false) => {
  const po = await db.$transaction((tx) => createPurchaseOrder(tx, {
    restaurantId: scope.restaurantId, supplierId,
    lines: [{ ingredientId, qtyBase: qty, expectedCostCents: net, taxPct: 19 }],
  }));
  await db.$transaction((tx) => receivePurchaseOrder(tx, {
    restaurantId: scope.restaurantId, purchaseOrderId: po.id, ivaDeductible: deductible,
    lines: [{ itemId: po.items[0].id, qtyBase: qty, costCents: net }],
  }));
  return po;
};
const snapshot = async () => ({
  ingredients: await db.ingredient.findMany({ where: { restaurantId: scope.restaurantId }, orderBy: { id: "asc" } }),
  levels: await db.stockLevel.findMany({ where: { restaurantId: scope.restaurantId }, orderBy: { id: "asc" } }),
  movements: await db.stockMovement.findMany({ where: { restaurantId: scope.restaurantId }, orderBy: { id: "asc" } }),
  purchases: await db.purchaseOrder.findMany({ where: { restaurantId: scope.restaurantId }, orderBy: { id: "asc" }, include: { items: { orderBy: { id: "asc" } }, payments: true } }),
  invoices: await db.purchaseInvoiceUpload.findMany({ where: { restaurantId: scope.restaurantId }, orderBy: { id: "asc" } }),
  supplierItems: await db.supplierIngredient.findMany({ where: { supplier: { restaurantId: scope.restaurantId } }, include: { priceHistory: true } }),
  entries: await db.journalEntry.findMany({ where: { restaurantId: scope.restaurantId }, include: { lines: true } }),
});

describe("received-purchase cost recovery with real PostgreSQL", () => {
  it("uses the confirmed AI invoice without a presentation and does not mutate stock, invoices, payables, journals or manual prices during reads", async () => {
    const ing = await ingredient();
    const upload = await db.purchaseInvoiceUpload.create({ data: { restaurantId: scope.restaurantId, fileUrl: "uploads/fixture.pdf", extraction: {} } });
    const response = await confirmInvoice(request({ supplierId, mode: "receive", supplierInvoiceNumber: "FIXTURE-1", lines: [{
      ingredientId: ing.id, qtyBase: 2000, expectedCostCents: 1000000, taxPct: 19, expectedIncCents: 100000,
    }], retefuenteCents: 10000 }), { params: Promise.resolve({ id: upload.id }) });
    expect(response.status).toBe(201);
    const line = await db.purchaseOrderItem.findFirstOrThrow({ where: { ingredientId: ing.id } });
    expect(line.supplierItemId).toBeNull();
    expect(line.lastReceivedAt).toBeInstanceOf(Date);
    const before = await snapshot();
    const ctx = (await loadCostContext(scope.restaurantId)).ctx;
    expect(resolveIngredientCost(ctx, ing.id)).toEqual({ source: "purchase", costPerBase: 645 });
    expect(costRecipeItems(ctx, [{ ingredientId: ing.id, qtyBase: 250, wastePct: 0 }])).toMatchObject({ costCents: 161250, complete: true });
    const catalog = await (await getIngredients(request(null))).json();
    expect(catalog.ingredients.find((i: { id: string }) => i.id === ing.id)).toMatchObject({
      referencePriceCents: null, costPerBase: 645, costSource: "purchase",
      purchaseCost: { qtyBase: 2000, totalCostCents: 1290000, dateBasis: "line_received", supplierName: "Fixture supplier" },
    });
    expect(await snapshot()).toEqual(before);
    expect(before.levels).toHaveLength(0);
    expect(before.movements).toHaveLength(0);
  });

  it("recovers legacy completed purchases and ignores unrelated later payment/header edits", async () => {
    const ing = await ingredient();
    const old = await legacy([legacyLine(ing.id)], { receivedAt: date("2026-10-05") });
    const newer = await legacy([legacyLine(ing.id, { receivedCostCents: 1200000, nonInventoryReceivedCostCents: 1200000 })], { receivedAt: date("2026-10-07") });
    await db.purchaseOrder.update({ where: { id: old.id }, data: { updatedAt: date("2026-11-08"), paidCents: 20000, paymentNote: "Later payment" } });
    const before = await snapshot();
    expect((await loadPurchaseCosts(scope.restaurantId)).get(ing.id)).toMatchObject({ purchaseOrderId: newer.id, totalCostCents: 1200000, dateBasis: "order_received" });
    expect(await effective(ing.id)).toEqual({ source: "purchase", costPerBase: 600 });
    expect(await snapshot()).toEqual(before);
    expect(before.purchases.flatMap((p) => p.items).every((item) => item.lastReceivedAt === null)).toBe(true);
  });

  it("updates a non-stock partial receipt's timestamp and cumulative weighted cost", async () => {
    const ing = await ingredient();
    const po = await db.$transaction((tx) => createPurchaseOrder(tx, { restaurantId: scope.restaurantId, supplierId, lines: [{ ingredientId: ing.id, qtyBase: 2000, expectedCostCents: 200000 }] }));
    await db.$transaction((tx) => receivePurchaseOrder(tx, { restaurantId: scope.restaurantId, purchaseOrderId: po.id, lines: [{ itemId: po.items[0].id, qtyBase: 500, costCents: 50000 }] }));
    expect((await loadPurchaseCosts(scope.restaurantId)).get(ing.id)).toMatchObject({ qtyBase: 500, totalCostCents: 50000, dateBasis: "line_received" });
    await db.purchaseOrderItem.update({ where: { id: po.items[0].id }, data: { lastReceivedAt: date("2026-01-01") } });
    await db.$transaction((tx) => receivePurchaseOrder(tx, { restaurantId: scope.restaurantId, purchaseOrderId: po.id, lines: [{ itemId: po.items[0].id, qtyBase: 500, costCents: 100000 }] }));
    const updated = await db.purchaseOrderItem.findUniqueOrThrow({ where: { id: po.items[0].id } });
    expect(updated.lastReceivedAt!.getTime()).toBeGreaterThan(date("2026-01-01").getTime());
    expect(await effective(ing.id)).toEqual({ source: "purchase", costPerBase: 150 });
    expect((await loadPurchaseCosts(scope.restaurantId)).get(ing.id)).toMatchObject({ qtyBase: 1000, totalCostCents: 150000, dateBasis: "line_received" });
  });

  it("preserves stock valuation priority, then retains the purchase cost after depletion", async () => {
    const ing = await ingredient(true);
    await receipt(ing.id);
    expect(await effective(ing.id)).toEqual({ source: "stock", costPerBase: 595 });
    await db.$transaction((tx) => applyStockMovement(tx, { restaurantId: scope.restaurantId, ingredientId: ing.id, kind: "sale_consumption", qtyBase: 2000 }));
    const before = await snapshot();
    expect(await effective(ing.id)).toEqual({ source: "purchase", costPerBase: 595 });
    expect(await snapshot()).toEqual(before);
  });

  it("groups repeated lines and mixed tracked/non-stock receipts exactly once, using frozen taxes", async () => {
    const ing = await ingredient();
    const po = await legacy([
      legacyLine(ing.id, { qtyOrderedBase: 1000, receivedQtyBase: 1000, nonInventoryReceivedCostCents: 0 }),
      legacyLine(ing.id, { qtyOrderedBase: 1000, receivedQtyBase: 1000, nonInventoryReceivedNonDeductibleTaxCents: 190000, nonInventoryReceivedIncCents: 100000 }),
    ]);
    await db.stockMovement.create({ data: { restaurantId: scope.restaurantId, ingredientId: ing.id, purchaseOrderId: po.id, kind: "purchase_in", qtyBase: 1000, valueCents: 1190000 } });
    await db.restaurant.update({ where: { id: scope.restaurantId }, data: { purchaseIvaDeductible: true } });
    expect((await loadPurchaseCosts(scope.restaurantId)).get(ing.id)).toMatchObject({ qtyBase: 2000, totalCostCents: 2480000, costPerBase: 1240 });
  });

  it("dates legacy partials from complete stock evidence or explicitly from order creation", async () => {
    const tracked = await ingredient(true);
    const untracked = await ingredient();
    const trackedPo = await legacy([legacyLine(tracked.id, { nonInventoryReceivedCostCents: 0 })], { status: "partially_received", receivedAt: null });
    await db.stockMovement.create({ data: { restaurantId: scope.restaurantId, ingredientId: tracked.id, purchaseOrderId: trackedPo.id, kind: "purchase_in", qtyBase: 2000, valueCents: 1000000, createdAt: date("2026-10-09") } });
    await legacy([legacyLine(untracked.id)], { status: "partially_received", receivedAt: null });
    const costs = await loadPurchaseCosts(scope.restaurantId);
    expect(costs.get(tracked.id)).toMatchObject({ dateBasis: "stock_movement", receivedAt: "2026-10-09T12:00:00.000Z" });
    expect(costs.get(untracked.id)).toMatchObject({ dateBasis: "order_created", receivedAt: "2026-10-01T12:00:00.000Z" });
  });

  it("does not use drafts, sent/canceled documents, unreceived quantities or expected prices", async () => {
    const ing = await ingredient();
    for (const status of ["draft", "sent", "canceled"] as const) await legacy([legacyLine(ing.id)], { status });
    await legacy([legacyLine(ing.id, { receivedQtyBase: 0, receivedCostCents: 0, nonInventoryReceivedCostCents: 0 })]);
    expect((await loadPurchaseCosts(scope.restaurantId)).has(ing.id)).toBe(false);
    expect(await effective(ing.id)).toBeNull();
  });

  it("does not disguise a latest inconsistent purchase with an older valid cheap one", async () => {
    const ing = await ingredient(true);
    await legacy([legacyLine(ing.id)]);
    await legacy([legacyLine(ing.id, { nonInventoryReceivedCostCents: 0 })], { receivedAt: date("2026-10-12") });
    expect((await loadPurchaseCosts(scope.restaurantId)).has(ing.id)).toBe(false);
    expect(await effective(ing.id)).toBeNull();
  });

  it("rejects contradictory double valuation and cross-tenant evidence, including quoted filter values", async () => {
    const ing = await ingredient();
    const po = await legacy([legacyLine(ing.id)]);
    await db.stockMovement.create({ data: { restaurantId: scope.restaurantId, ingredientId: ing.id, purchaseOrderId: po.id, kind: "purchase_in", qtyBase: 2000, valueCents: 1000000 } });
    expect((await loadPurchaseCosts(scope.restaurantId)).has(ing.id)).toBe(false);
    const other = await db.restaurant.create({ data: { name: "Other tenant", slug: `purchase-other-${randomUUID()}` } });
    tenants.push(other.id);
    const foreign = await ingredient(false, other.id);
    await legacy([legacyLine(foreign.id)]);
    expect((await loadPurchaseCosts(scope.restaurantId)).has(foreign.id)).toBe(false);
    expect((await loadPurchaseCosts(other.id)).has(foreign.id)).toBe(false);
    expect(await loadPurchaseCosts(scope.restaurantId, ["' OR true --"])).toEqual(new Map());
    expect(await loadPurchaseCosts("' OR true --")).toEqual(new Map());
    expect(await loadPurchaseCosts(scope.restaurantId, [])).toEqual(new Map());
  });

  it("returns effective costs after manual-price edits and new creates without changing manual-price semantics", async () => {
    const ing = await ingredient();
    await legacy([legacyLine(ing.id)]);
    const params = { params: Promise.resolve({ id: ing.id }) };
    const edited = await editIngredient(request({ referencePriceCents: 0 }), params);
    expect((await edited.json()).ingredient).toMatchObject({ costPerBase: 0, costSource: "reference", purchaseCost: { costPerBase: 500 } });
    const cleared = await editIngredient(request({ referencePriceCents: null }), params);
    expect((await cleared.json()).ingredient).toMatchObject({ costPerBase: 500, costSource: "purchase" });
    const created = await createIngredientRoute(request({ name: `Manual ${randomUUID()}`, measureKind: "mass", referencePriceCents: 120000 }));
    expect(created.status).toBe(201);
    expect((await created.json()).ingredient).toMatchObject({ costPerBase: 120, costSource: "reference", purchaseCost: null });
  });

  it("keeps deducted VAT outside cost and actual discounts inside received net", async () => {
    const ing = await ingredient();
    await receipt(ing.id, 800000, 2000, true);
    expect(await effective(ing.id)).toEqual({ source: "purchase", costPerBase: 400 });
    await db.restaurant.update({ where: { id: scope.restaurantId }, data: { purchaseIvaDeductible: false } });
    expect(await effective(ing.id)).toEqual({ source: "purchase", costPerBase: 400 });
  });
});
