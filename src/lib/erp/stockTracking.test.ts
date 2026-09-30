import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { disableInventoryTracking } from "./stockTracking";

const lock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/orderLock", () => ({ lockStock: lock }));
const ingredient = { id: "i", restaurantId: "r", measureKind: "mass", trackInventory: true, updatedAt: new Date("2026-09-30T11:00:00.000Z") };
const updatedAt = new Date("2026-09-30T12:00:00.000Z");
const mocks = {
  ingredient: { findUnique: vi.fn(), update: vi.fn() },
  stockLevel: { findUnique: vi.fn(), update: vi.fn() },
  stockMovement: { count: vi.fn(), create: vi.fn() },
};
const tx = mocks as unknown as Prisma.TransactionClient;
const args = { restaurantId: "r", ingredientId: "i", createdById: "u" };
const snapshot = (qtyBase = 2500, totalValueCents = 120000) => ({ qtyBase, totalValueCents, updatedAt: updatedAt.toISOString(), ingredientUpdatedAt: ingredient.updatedAt.toISOString(), movementCount: 2, measureKind: "mass" as const });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.ingredient.findUnique.mockResolvedValue(ingredient);
  mocks.stockLevel.findUnique.mockResolvedValue({ qtyBase: 2500, totalValueCents: 120000, updatedAt, restaurantId: "r" });
  mocks.stockMovement.count.mockResolvedValue(2);
});

describe("confirmed inventory tracking disable", () => {
  it("requires a balance review without changing anything", async () => {
    expect(await disableInventoryTracking(tx, args)).toEqual({ error: "inventory_balance_remaining", stockReset: snapshot() });
    expect(mocks.stockMovement.create).not.toHaveBeenCalled();
    expect(mocks.stockLevel.update).not.toHaveBeenCalled();
    expect(mocks.ingredient.update).not.toHaveBeenCalled();
  });
  it.each([[2500, 120000, "adjust_out"], [-2500, -120000, "adjust_in"], [0, 120000, "adjust_out"], [0, -120000, "adjust_in"], [-2500, 120000, "adjust_in"]])("zeros exact quantity %s and value %s", async (qty, value, kind) => {
    const qtyBase = Number(qty); const totalValueCents = Number(value);
    mocks.stockLevel.findUnique.mockResolvedValue({ qtyBase, totalValueCents, updatedAt, restaurantId: "r" });
    expect(await disableInventoryTracking(tx, { ...args, resetStock: snapshot(qtyBase, totalValueCents) })).toEqual({ ok: true });
    expect(mocks.stockMovement.create).toHaveBeenCalledWith({ data: expect.objectContaining({ restaurantId: "r", ingredientId: "i", qtyBase: -qtyBase, valueCents: -totalValueCents, kind, note: "inventory_tracking_disabled", createdById: "u" }) });
    expect(mocks.stockLevel.update).toHaveBeenCalledWith({ where: { ingredientId: "i" }, data: { qtyBase: 0, totalValueCents: 0 } });
    expect(mocks.ingredient.update).toHaveBeenCalledWith({ where: { id: "i", restaurantId: "r" }, data: { trackInventory: false, reorderPointBase: null, reorderQtyBase: null } });
    expect(lock).toHaveBeenCalledWith(tx, "r");
  });
  it.each([{ qtyBase: 2501 }, { totalValueCents: 120001 }, { updatedAt: "2026-09-30T12:00:01.000Z" }, { movementCount: 3 }, { ingredientUpdatedAt: "2026-09-30T11:00:01.000Z" }, { measureKind: "volume" as const }])("rejects a stale or forged review %j", async (change) => {
    expect(await disableInventoryTracking(tx, { ...args, resetStock: { ...snapshot(), ...change } })).toEqual({ error: "stock_reset_conflict", stockReset: snapshot() });
    expect(mocks.stockLevel.update).not.toHaveBeenCalled();
    expect(mocks.stockMovement.create).not.toHaveBeenCalled();
    expect(mocks.ingredient.update).not.toHaveBeenCalled();
  });
  it("treats an already disabled zero balance retry as idempotent", async () => {
    mocks.ingredient.findUnique.mockResolvedValue({ ...ingredient, trackInventory: false });
    mocks.stockLevel.findUnique.mockResolvedValue({ qtyBase: 0, totalValueCents: 0, updatedAt, restaurantId: "r" });
    expect(await disableInventoryTracking(tx, { ...args, resetStock: snapshot() })).toEqual({ ok: true });
    expect(mocks.stockMovement.create).not.toHaveBeenCalled();
  });
  it("disables an ingredient that never had a stock row without inventing history", async () => {
    mocks.stockLevel.findUnique.mockResolvedValue(null);
    expect(await disableInventoryTracking(tx, args)).toEqual({ ok: true });
    expect(mocks.stockMovement.create).not.toHaveBeenCalled();
    expect(mocks.stockLevel.update).not.toHaveBeenCalled();
  });
  it("denies other tenant ingredients before reading stock", async () => {
    mocks.ingredient.findUnique.mockResolvedValue({ ...ingredient, restaurantId: "other" });
    expect(await disableInventoryTracking(tx, args)).toEqual({ error: "not_found" });
    expect(mocks.stockLevel.findUnique).not.toHaveBeenCalled();
  });
  it("does not swallow a failed ledger append", async () => {
    mocks.stockMovement.create.mockRejectedValue(new Error("ledger unavailable"));
    await expect(disableInventoryTracking(tx, { ...args, resetStock: snapshot() })).rejects.toThrow("ledger unavailable");
    expect(mocks.ingredient.update).not.toHaveBeenCalled();
  });
});
