import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { createPurchaseOrder, receivePurchaseOrder } from "../src/lib/erp/purchasing";
import { computeMonthPnl, loadInventoryBook, loadPurchasesBook } from "../src/lib/erp/accountingData";
import { consumeOrderStock } from "../src/lib/erp/consumption";
import { applyStockMovement } from "../src/lib/erp/stock";
import { POST as createIngredient } from "../src/app/api/operator/ingredients/route";
import { PATCH as patchIngredient } from "../src/app/api/operator/ingredients/[id]/route";
import { POST as createProduct } from "../src/app/api/operator/menu-items/route";
import { PATCH as patchProduct } from "../src/app/api/operator/menu-items/[id]/route";

const scope = vi.hoisted(() => ({ restaurantId: "" }));
// Keep route validation, ownership, transactions and persistence real. The browser
// suite exercises these same routes through the real login and secureApi guard.
vi.mock("../src/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("../src/lib/erp/access", () => ({
  getErpContext: async () => ({ restaurantId: scope.restaurantId, country: "CO" }),
  isDenied: () => false,
}));
vi.mock("../src/auth", () => ({ auth: async () => ({ user: { role: "operator" } }) }));
vi.mock("../src/lib/activeRestaurant", () => ({ getActiveRestaurantId: async () => scope.restaurantId }));

const url = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["127.0.0.1", "localhost"].includes(url.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(url.pathname)) {
  throw new Error("Isolated local database required");
}
const tenants: string[] = [];
let categoryId: string;
const request = (path: string, method: string, data: unknown) => new Request(`http://localhost/api/operator/${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const toggle = (id: string, value: boolean) => patchIngredient(request(`ingredients/${id}`, "PATCH", { trackInventory: value }), params(id));

beforeAll(async () => {
  for (let i = 0; i < 2; i++) {
    const restaurant = await db.restaurant.create({ data: { name: "Inventory validation", slug: `tracking-${randomUUID()}`, enabledModules: ["inventory", "recipes", "purchasing"] } });
    tenants.push(restaurant.id);
  }
  scope.restaurantId = tenants[0];
  categoryId = (await db.category.create({ data: { restaurantId: tenants[0], label: "Validación", slug: "validacion" } })).id;
});
afterAll(async () => {
  await db.purchaseOrder.deleteMany({ where: { restaurantId: { in: tenants } } });
  await db.recipe.deleteMany({ where: { restaurantId: { in: tenants } } });
  await db.restaurant.deleteMany({ where: { id: { in: tenants } } });
  await db.$disconnect();
});

describe("inventory tracking routes with PostgreSQL", () => {
  it("defaults existing workflows to tracked and persists explicit false for ingredients and products", async () => {
    scope.restaurantId = tenants[0];
    const defaults = await createIngredient(request("ingredients", "POST", { name: "Ingrediente con inventario", measureKind: "count" }));
    expect(defaults.status).toBe(201);
    expect((await defaults.json()).ingredient.trackInventory).toBe(true);
    const ingredient = await createIngredient(request("ingredients", "POST", { name: "Servicio sin inventario", measureKind: "count", trackInventory: false }));
    expect(ingredient.status).toBe(201);
    const { ingredient: saved } = await ingredient.json();
    expect((await db.ingredient.findUniqueOrThrow({ where: { id: saved.id } })).trackInventory).toBe(false);
    const product = await createProduct(request("menu-items", "POST", { categoryId, name: "Producto sin inventario", priceCents: 500000, trackInventory: false }));
    expect(product.status).toBe(200);
    const { id } = await product.json();
    expect((await db.menuItem.findUniqueOrThrow({ where: { id } })).trackInventory).toBe(false);
    expect((await patchProduct(request(`menu-items/${id}`, "PATCH", { trackInventory: true }), params(id))).status).toBe(200);
    expect((await db.menuItem.findUniqueOrThrow({ where: { id } })).trackInventory).toBe(true);
    expect((await toggle(saved.id, true)).status).toBe(200);
    expect((await db.ingredient.findUniqueOrThrow({ where: { id: saved.id } })).trackInventory).toBe(true);
  });

  it("rejects ambiguous string booleans and cross-tenant changes without altering records", async () => {
    scope.restaurantId = tenants[0];
    const ingredient = await db.ingredient.create({ data: { restaurantId: tenants[0], name: "Privado", measureKind: "count" } });
    const product = await db.menuItem.create({ data: { restaurantId: tenants[0], categoryId, name: "Privado", priceCents: 100 } });
    expect((await patchIngredient(request(`ingredients/${ingredient.id}`, "PATCH", { trackInventory: "false" }), params(ingredient.id))).status).toBe(400);
    expect((await patchProduct(request(`menu-items/${product.id}`, "PATCH", { trackInventory: "false" }), params(product.id))).status).toBe(400);
    scope.restaurantId = tenants[1];
    expect((await toggle(ingredient.id, false)).status).toBe(404);
    expect((await patchProduct(request(`menu-items/${product.id}`, "PATCH", { trackInventory: false }), params(product.id))).status).toBe(403);
    expect((await db.ingredient.findUniqueOrThrow({ where: { id: ingredient.id } })).trackInventory).toBe(true);
    expect((await db.menuItem.findUniqueOrThrow({ where: { id: product.id } })).trackInventory).toBe(true);
    scope.restaurantId = tenants[0];
  });

  it.each([{ qtyBase: 1000, totalValueCents: 500 }, { qtyBase: -1000, totalValueCents: 0 }, { qtyBase: 0, totalValueCents: 500 }])("preserves stock when disabling with balance %o", async (balance) => {
    const ingredient = await db.ingredient.create({ data: { restaurantId: tenants[0], name: `Saldo ${randomUUID()}`, measureKind: "count", stockLevel: { create: { restaurantId: tenants[0], ...balance } } } });
    const response = await toggle(ingredient.id, false);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "inventory_balance_remaining" });
    expect((await db.ingredient.findUniqueOrThrow({ where: { id: ingredient.id } })).trackInventory).toBe(true);
    expect(await db.stockLevel.findUniqueOrThrow({ where: { ingredientId: ingredient.id } })).toMatchObject(balance);
  });

  it("supports disabling an empty stock record then re-enabling future movements", async () => {
    const ingredient = await db.ingredient.create({ data: { restaurantId: tenants[0], name: "Vacío", measureKind: "count", stockLevel: { create: { restaurantId: tenants[0] } } } });
    expect((await toggle(ingredient.id, false)).status).toBe(200);
    await expect(db.$transaction((tx) => applyStockMovement(tx, { restaurantId: tenants[0], ingredientId: ingredient.id, kind: "adjust_in", qtyBase: 1000, totalCostCents: 500 }))).rejects.toMatchObject({ code: "ingredient_not_tracked" });
    expect(await db.stockMovement.count({ where: { ingredientId: ingredient.id } })).toBe(0);
    expect((await toggle(ingredient.id, true)).status).toBe(200);
    await db.$transaction((tx) => applyStockMovement(tx, { restaurantId: tenants[0], ingredientId: ingredient.id, kind: "adjust_in", qtyBase: 1000, totalCostCents: 500 }));
    expect(await db.stockLevel.findUniqueOrThrow({ where: { ingredientId: ingredient.id } })).toMatchObject({ qtyBase: 1000, totalValueCents: 500 });
  });

  it("receives a mixed purchase fully while only inventory items gain stock", async () => {
    const tracked = await db.ingredient.create({ data: { restaurantId: tenants[0], name: "Materia prima compra", measureKind: "mass" } });
    const service = await db.ingredient.create({ data: { restaurantId: tenants[0], name: "Servicio compra", measureKind: "count", trackInventory: false } });
    const supplier = await db.supplier.create({ data: { restaurantId: tenants[0], name: "Proveedor validación", paymentTermsDays: 30 } });
    const purchase = await db.$transaction((tx) => createPurchaseOrder(tx, { restaurantId: tenants[0], supplierId: supplier.id, lines: [
      { ingredientId: tracked.id, qtyBase: 2000, expectedCostCents: 20000, taxPct: 0 },
      { ingredientId: service.id, qtyBase: 1000, expectedCostCents: 50000, taxPct: 19 },
    ] }));
    const result = await db.$transaction((tx) => receivePurchaseOrder(tx, { restaurantId: tenants[0], purchaseOrderId: purchase.id, lines: purchase.items.map((item) => ({ itemId: item.id, qtyBase: item.qtyOrderedBase, costCents: item.expectedCostCents })) }));
    expect(result.complete).toBe(true);
    expect(result.purchaseOrder.status).toBe("received");
    expect(result.purchaseOrder.invoiceDueAt).toBeInstanceOf(Date);
    const lines = await db.purchaseOrderItem.findMany({ where: { purchaseOrderId: purchase.id } });
    expect(lines.find((line) => line.ingredientId === service.id)).toMatchObject({ receivedQtyBase: 1000, receivedCostCents: 50000, nonInventoryReceivedCostCents: 50000, taxPct: 19 });
    expect(lines.find((line) => line.ingredientId === tracked.id)).toMatchObject({ nonInventoryReceivedCostCents: 0 });
    expect(lines.reduce((sum, line) => sum + line.receivedCostCents, 0)).toBe(70000);
    expect(await db.stockMovement.count({ where: { purchaseOrderId: purchase.id } })).toBe(1);
    expect(await db.stockLevel.findUniqueOrThrow({ where: { ingredientId: tracked.id } })).toMatchObject({ qtyBase: 2000, totalValueCents: 20000 });
    expect(await db.stockLevel.findUnique({ where: { ingredientId: service.id } })).toBeNull();
  });

  it("a paid order skips untracked products and ingredients without losing the sale or consuming twice", async () => {
    const tracked = await db.ingredient.create({ data: { restaurantId: tenants[0], name: "Harina consumo", measureKind: "mass", stockLevel: { create: { restaurantId: tenants[0], qtyBase: 1000, totalValueCents: 10000 } } } });
    const untracked = await db.ingredient.create({ data: { restaurantId: tenants[0], name: "Agua consumo", measureKind: "volume", trackInventory: false } });
    const regular = await db.menuItem.create({ data: { restaurantId: tenants[0], categoryId, name: "Plato receta", priceCents: 1000000 } });
    const untrackedProduct = await db.menuItem.create({ data: { restaurantId: tenants[0], categoryId, name: "Producto sin descuento", priceCents: 500000, trackInventory: false } });
    await db.recipe.create({ data: { restaurantId: tenants[0], menuItemId: regular.id, items: { create: [{ ingredientId: tracked.id, qtyBase: 100 }, { ingredientId: untracked.id, qtyBase: 500 }] } } });
    await db.recipe.create({ data: { restaurantId: tenants[0], menuItemId: untrackedProduct.id, items: { create: { ingredientId: tracked.id, qtyBase: 300 } } } });
    const table = await db.table.create({ data: { restaurantId: tenants[0], number: 1, qrToken: randomUUID() } });
    const order = await db.order.create({ data: { restaurantId: tenants[0], tableId: table.id, shortCode: randomUUID(), status: "paid", subtotalCents: 2500000, totalCents: 2500000, items: { create: [
      { menuItemId: regular.id, nameSnapshot: regular.name, priceCentsSnapshot: regular.priceCents, qty: 2 },
      { menuItemId: untrackedProduct.id, nameSnapshot: untrackedProduct.name, priceCentsSnapshot: untrackedProduct.priceCents, qty: 1 },
    ] } } });
    expect(await consumeOrderStock(order.id)).toEqual({ status: "consumed", movements: 1 });
    expect(await consumeOrderStock(order.id)).toEqual({ status: "already" });
    expect(await db.stockLevel.findUniqueOrThrow({ where: { ingredientId: tracked.id } })).toMatchObject({ qtyBase: 800, totalValueCents: 8000 });
    expect(await db.stockLevel.findUnique({ where: { ingredientId: untracked.id } })).toBeNull();
    expect(await db.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: "paid", totalCents: 2500000 });
    expect(await db.stockMovement.count({ where: { orderId: order.id } })).toBe(1);
  });

  it.each([false, true])("freezes mixed-purchase expenses and IVA without double counting (deductible=%s)", async (ivaDeductible) => {
    const restaurant = await db.restaurant.create({ data: { name: "Inventory validation", slug: `tracking-tax-${randomUUID()}`, enabledModules: ["inventory", "recipes", "purchasing"], purchaseIvaDeductible: ivaDeductible } });
    tenants.push(restaurant.id);
    const restaurantId = restaurant.id;
    const tracked = await db.ingredient.create({ data: { restaurantId, name: "Materia prima gravada", measureKind: "mass" } });
    const service = await db.ingredient.create({ data: { restaurantId, name: "Servicio gravado", measureKind: "count", trackInventory: false } });
    const supplier = await db.supplier.create({ data: { restaurantId, name: "Proveedor gravado" } });
    const purchase = await db.$transaction((tx) => createPurchaseOrder(tx, { restaurantId, supplierId: supplier.id, lines: [
      { ingredientId: tracked.id, qtyBase: 2000, expectedCostCents: 20000, taxPct: 19 },
      { ingredientId: service.id, qtyBase: 1000, expectedCostCents: 50000, taxPct: 19 },
    ] }));
    await db.$transaction((tx) => receivePurchaseOrder(tx, { restaurantId, purchaseOrderId: purchase.id, ivaDeductible, lines: purchase.items.map((item) => ({ itemId: item.id, qtyBase: item.qtyOrderedBase, costCents: item.expectedCostCents })) }));
    const now = new Date();
    const range = { from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), to: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)) };
    const frozenServiceTax = ivaDeductible ? 0 : 9500;
    const inventoryValue = ivaDeductible ? 20000 : 23800;
    const serviceExpense = 50000 + frozenServiceTax;
    const linesBefore = await db.purchaseOrderItem.findMany({ where: { purchaseOrderId: purchase.id }, orderBy: { id: "asc" } });
    expect(linesBefore.find((line) => line.ingredientId === service.id)).toMatchObject({ receivedCostCents: 50000, nonInventoryReceivedCostCents: 50000, nonInventoryReceivedNonDeductibleTaxCents: frozenServiceTax });
    expect(linesBefore.find((line) => line.ingredientId === tracked.id)).toMatchObject({ receivedCostCents: 20000, nonInventoryReceivedCostCents: 0, nonInventoryReceivedNonDeductibleTaxCents: 0 });
    const pnlBefore = await computeMonthPnl(restaurantId, range);
    expect(pnlBefore).toMatchObject({ expensesCents: serviceExpense, purchasesReceivedCents: inventoryValue + serviceExpense, consumptionCents: 0, operatingProfitCents: -serviceExpense });
    expect(pnlBefore.expensesByCategory).toHaveLength(1);
    expect(pnlBefore.expensesByCategory[0]).toMatchObject({ source: "non_inventory_purchases", amountCents: serviceExpense });
    // The amount appears once in P&L; reception does not also materialize an
    // Expense row. Inventory remains an asset until a separate consumption.
    expect(await db.expense.count({ where: { restaurantId } })).toBe(0);
    expect(await db.stockMovement.count({ where: { restaurantId } })).toBe(1);
    expect((await loadInventoryBook(restaurantId)).totals.valueCents).toBe(inventoryValue);
    const bookBefore = await loadPurchasesBook(restaurantId, range);
    expect(bookBefore.totals).toMatchObject({ count: 1, receivedCents: 70000, ivaCents: 13300, nonInventoryReceivedCents: 50000, nonInventoryNonDeductibleTaxCents: frozenServiceTax });
    // Changing present-day classification and VAT preference cannot rewrite
    // the original completed purchase's frozen treatment.
    scope.restaurantId = restaurantId;
    try {
      expect((await toggle(service.id, true)).status).toBe(200);
      await db.restaurant.update({ where: { id: restaurantId }, data: { purchaseIvaDeductible: !ivaDeductible } });
      expect(await computeMonthPnl(restaurantId, range)).toEqual(pnlBefore);
      expect(await loadPurchasesBook(restaurantId, range)).toEqual(bookBefore);
      expect(await db.purchaseOrderItem.findMany({ where: { purchaseOrderId: purchase.id }, orderBy: { id: "asc" } })).toEqual(linesBefore);
      expect((await loadInventoryBook(restaurantId)).totals.valueCents).toBe(inventoryValue);
    } finally {
      scope.restaurantId = tenants[0];
    }
  });

  it("serializes a concurrent disable and receipt so untracked stock cannot retain a new balance", async () => {
    const ingredient = await db.ingredient.create({ data: { restaurantId: tenants[0], name: "Carrera", measureKind: "count" } });
    const outcomes = await Promise.allSettled([
      toggle(ingredient.id, false),
      db.$transaction((tx) => applyStockMovement(tx, { restaurantId: tenants[0], ingredientId: ingredient.id, kind: "adjust_in", qtyBase: 1000, totalCostCents: 500 })),
    ]);
    const saved = await db.ingredient.findUniqueOrThrow({ where: { id: ingredient.id }, include: { stockLevel: true } });
    const patch = outcomes[0];
    expect(patch.status).toBe("fulfilled");
    if (patch.status !== "fulfilled") throw patch.reason;
    if (saved.trackInventory) {
      expect(patch.value.status).toBe(409);
      expect(outcomes[1].status).toBe("fulfilled");
      expect(saved.stockLevel).toMatchObject({ qtyBase: 1000, totalValueCents: 500 });
    } else {
      expect(patch.value.status).toBe(200);
      expect(outcomes[1].status).toBe("rejected");
      expect(saved.stockLevel?.qtyBase ?? 0).toBe(0);
      expect(saved.stockLevel?.totalValueCents ?? 0).toBe(0);
    }
  });
});
