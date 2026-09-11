import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  findOrder: vi.fn(), transaction: vi.fn(), findItems: vi.fn(), findRecipes: vi.fn(),
  claim: vi.fn(), movement: vi.fn(), lock: vi.fn(), findIngredients: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: { order: { findUnique: mocks.findOrder }, $transaction: mocks.transaction } }));
vi.mock("@/lib/orderLock", () => ({ lockStock: mocks.lock }));
vi.mock("@/lib/erp/stock", () => ({ applyStockMovement: mocks.movement }));
vi.mock("@/lib/modules", () => ({ isModuleEnabled: () => true }));
import { consumeOrderStock } from "./consumption";
const tx = {
  orderItem: { findMany: mocks.findItems }, recipe: { findMany: mocks.findRecipes },
  order: { updateMany: mocks.claim }, ingredient: { findMany: mocks.findIngredients },
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.findOrder.mockResolvedValue({ id: "order", restaurantId: "r", status: "paid", stockConsumedAt: null, restaurant: { enabledModules: [], inventoryExcludedCategories: [] } });
  mocks.transaction.mockImplementation((fn) => fn(tx));
  mocks.findItems.mockResolvedValue([{ menuItemId: "dish", qty: 2, cancelledAt: null, cancellationKind: null, modifierSelections: {}, round: null }]);
  mocks.findRecipes.mockResolvedValue([{ menuItemId: "dish", items: [{ ingredientId: "tracked", qtyBase: 3, wastePct: 0 }, { ingredientId: "untracked", qtyBase: 4, wastePct: 0 }], modifierItems: [] }]);
  mocks.claim.mockResolvedValue({ count: 1 });
  mocks.movement.mockImplementation((_tx, args) => args.ingredientId === "untracked" ? null : { movement: { id: "m" } });
});
describe("sale inventory tracking", () => {
  it("reads only tracked dish recipes under the tracking lock and counts actual movements", async () => {
    await expect(consumeOrderStock("order")).resolves.toEqual({ status: "consumed", movements: 1 });
    expect(mocks.lock).toHaveBeenCalledWith(tx, "r");
    expect(mocks.lock.mock.invocationCallOrder[0]).toBeLessThan(mocks.findRecipes.mock.invocationCallOrder[0]);
    expect(mocks.findRecipes).toHaveBeenCalledWith(expect.objectContaining({ where: { restaurantId: "r", menuItemId: { in: ["dish"] }, menuItem: { trackInventory: true } } }));
    expect(mocks.movement).toHaveBeenCalledWith(tx, expect.objectContaining({ ingredientId: "untracked", qtyBase: 8 }), { allowInactive: true, skipUntracked: true });
  });
  it("marks sales of untracked dishes consumed without any stock movement", async () => {
    mocks.findRecipes.mockResolvedValue([]);
    await expect(consumeOrderStock("order")).resolves.toEqual({ status: "consumed", movements: 0 });
    expect(mocks.claim).toHaveBeenCalledOnce();
    expect(mocks.movement).not.toHaveBeenCalled();
  });
  it("does not duplicate consumption if a second worker claimed the order", async () => {
    mocks.claim.mockResolvedValue({ count: 0 });
    await expect(consumeOrderStock("order")).resolves.toEqual({ status: "already" });
    expect(mocks.movement).not.toHaveBeenCalled();
  });
});
