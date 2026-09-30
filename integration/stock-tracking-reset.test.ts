import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { applyStockMovement } from "../src/lib/erp/stock";
import { disableInventoryTracking, type StockResetSnapshot } from "../src/lib/erp/stockTracking";
import { PATCH } from "../src/app/api/operator/ingredients/[id]/route";

const scope = vi.hoisted(() => ({ restaurantId: "", userId: "" }));
vi.mock("../src/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("../src/lib/erp/access", () => ({ getErpContext: async () => ({ ...scope, country: "CO" }), isDenied: () => false }));
const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["localhost", "127.0.0.1"].includes(database.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname)) throw new Error("Isolated local database required");
const tenants: string[] = [];
let ingredientId: string;
const patch = (body: unknown) => PATCH(new Request("http://localhost/api/operator/ingredients/i", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: ingredientId }) });
const level = () => db.stockLevel.findUniqueOrThrow({ where: { ingredientId } });
const adjustments = () => db.stockMovement.findMany({ where: { ingredientId, note: "inventory_tracking_disabled" } });
async function review(): Promise<StockResetSnapshot> {
  const response = await patch({ trackInventory: false });
  expect(response.status).toBe(409);
  const body = await response.json(); expect(body.error).toBe("inventory_balance_remaining");
  return body.stockReset;
}
beforeEach(async () => {
  const tenant = await db.restaurant.create({ data: { name: "Reset inventario prueba", slug: `tracking-reset-${randomUUID()}`, enabledModules: ["inventory"] } });
  tenants.push(tenant.id); scope.restaurantId = tenant.id;
  scope.userId = (await db.user.create({ data: { restaurantId: tenant.id, role: "operator", email: `${randomUUID()}@example.test`, passwordHash: "test-only" } })).id;
  ingredientId = (await db.ingredient.create({ data: { restaurantId: tenant.id, name: "Insumo", measureKind: "mass", reorderPointBase: 500, reorderQtyBase: 1000, stockLevel: { create: { restaurantId: tenant.id, qtyBase: 2500, totalValueCents: 120000 } } } })).id;
  await db.stockMovement.create({ data: { restaurantId: tenant.id, ingredientId, kind: "purchase_in", qtyBase: 2500, valueCents: 120000 } });
});
afterAll(async () => { await db.restaurant.deleteMany({ where: { id: { in: tenants } } }); await db.$disconnect(); });

describe("confirmed non-inventory conversion on PostgreSQL", () => {
  it.each([[2500, 120000], [-2500, -120000], [0, 120000], [0, -120000], [-2500, 120000], [-2147483648, -2147483648]])("preserves history and zeroes %i quantity / %i value exactly", async (qtyBase, totalValueCents) => {
    await db.stockLevel.update({ where: { ingredientId }, data: { qtyBase, totalValueCents } });
    const historic = await db.stockMovement.findMany({ where: { ingredientId } });
    const snapshot = await review();
    expect(await level()).toMatchObject({ qtyBase, totalValueCents }); expect(await adjustments()).toHaveLength(0);
    const response = await patch({ trackInventory: false, resetStock: snapshot });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ingredient: { trackInventory: false, reorderPointBase: null, reorderQtyBase: null } });
    expect(await level()).toMatchObject({ qtyBase: 0, totalValueCents: 0 });
    const moves = await adjustments();
    expect(moves.reduce((s, m) => s + m.qtyBase, 0)).toBe(0 - qtyBase);
    expect(moves.reduce((s, m) => s + m.valueCents, 0)).toBe(0 - totalValueCents);
    expect(moves.every((m) => m.createdById === scope.userId)).toBe(true);
    expect(await db.stockMovement.findMany({ where: { id: { in: historic.map((m) => m.id) } } })).toEqual(historic);
    expect((await patch({ trackInventory: false, resetStock: snapshot })).status).toBe(200);
    expect(await adjustments()).toHaveLength(moves.length);
  });
  it("requires another review after a stock movement even if its net balance is unchanged", async () => {
    const snapshot = await review();
    await db.$transaction(async (tx) => {
      await applyStockMovement(tx, { restaurantId: scope.restaurantId, ingredientId, kind: "adjust_in", qtyBase: 1000 });
      await applyStockMovement(tx, { restaurantId: scope.restaurantId, ingredientId, kind: "adjust_out", qtyBase: 1000 });
    });
    const response = await patch({ trackInventory: false, resetStock: snapshot });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "stock_reset_conflict", stockReset: { movementCount: snapshot.movementCount + 2 } });
    expect(await adjustments()).toHaveLength(0); expect(await level()).toMatchObject({ qtyBase: 2500, totalValueCents: 120000 });
  });
  it("rejects confirmation after ingredient metadata changes", async () => {
    const snapshot = await review();
    await db.ingredient.update({ where: { id: ingredientId }, data: { updatedAt: new Date(Date.now() + 1000), name: "Nuevo nombre" } });
    const response = await patch({ trackInventory: false, resetStock: snapshot });
    expect(response.status).toBe(409); expect((await response.json()).error).toBe("stock_reset_conflict");
    expect(await adjustments()).toHaveLength(0);
  });
  it("serializes duplicate confirmations into a single adjustment", async () => {
    const snapshot = await review();
    const responses = await Promise.all([patch({ trackInventory: false, resetStock: snapshot }), patch({ trackInventory: false, resetStock: snapshot })]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(await adjustments()).toHaveLength(1);
  });
  it("serializes a concurrent sale without losing stock or counting it twice", async () => {
    const snapshot = await review();
    const [response, sale] = await Promise.all([
      patch({ trackInventory: false, resetStock: snapshot }),
      db.$transaction((tx) => applyStockMovement(tx, { restaurantId: scope.restaurantId, ingredientId, kind: "sale_consumption", qtyBase: 1000 }, { skipUntracked: true })),
    ]);
    if (response.status === 200) {
      expect(sale).toBeNull(); expect(await adjustments()).toHaveLength(1); expect((await level()).qtyBase).toBe(0);
    } else {
      expect(response.status).toBe(409); expect((await response.json()).error).toBe("stock_reset_conflict");
      expect(sale).not.toBeNull(); expect(await adjustments()).toHaveLength(0); expect((await level()).qtyBase).toBe(1500);
    }
  });
  it("rolls back ledger, balances and flags together if the transaction fails", async () => {
    const snapshot = await review();
    await expect(db.$transaction(async (tx) => {
      expect(await disableInventoryTracking(tx, { restaurantId: scope.restaurantId, ingredientId, createdById: scope.userId, resetStock: snapshot })).toEqual({ ok: true });
      throw new Error("intentional rollback");
    })).rejects.toThrow("intentional rollback");
    expect(await level()).toMatchObject({ qtyBase: 2500, totalValueCents: 120000 }); expect(await adjustments()).toHaveLength(0);
    expect(await db.ingredient.findUniqueOrThrow({ where: { id: ingredientId } })).toMatchObject({ trackInventory: true, reorderPointBase: 500 });
  });
});
