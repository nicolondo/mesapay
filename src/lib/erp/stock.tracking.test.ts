import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma, StockMovementKind } from "@prisma/client";
import { applyStockMovement } from "./stock";

const lock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/orderLock", () => ({ lockStock: lock }));

function fixture(tracked = false) {
  const tx = {
    ingredient: { findUnique: vi.fn().mockResolvedValue({ restaurantId: "r", active: true, trackInventory: tracked }) },
    stockLevel: {
      findUnique: vi.fn().mockResolvedValue({ qtyBase: 10, totalValueCents: 200 }),
      create: vi.fn(), update: vi.fn().mockResolvedValue({ qtyBase: 8, totalValueCents: 160 }),
    },
    stockMovement: { create: vi.fn().mockResolvedValue({ id: "movement" }) },
  };
  return { tx, client: tx as unknown as Prisma.TransactionClient };
}
const args = { restaurantId: "r", ingredientId: "i", kind: "sale_consumption" as const, qtyBase: 2 };

beforeEach(() => vi.clearAllMocks());
describe("inventory tracking movement boundary", () => {
  it.each(["purchase_in", "sale_consumption", "production_out", "count_adjust", "adjust_in"] as StockMovementKind[])("skips automatic %s without reading or writing balances", async (kind) => {
    const { tx, client } = fixture();
    await expect(applyStockMovement(client, { ...args, kind }, { skipUntracked: true })).resolves.toBeNull();
    expect(lock).toHaveBeenCalledWith(client, "r");
    expect(tx.stockLevel.findUnique).not.toHaveBeenCalled();
    expect(tx.stockLevel.update).not.toHaveBeenCalled();
    expect(tx.stockMovement.create).not.toHaveBeenCalled();
  });
  it.each(["purchase_in", "adjust_in", "adjust_out", "waste", "production_in", "transfer_in", "transfer_out"] as StockMovementKind[])("rejects explicit %s for an untracked ingredient", async (kind) => {
    const { tx, client } = fixture();
    await expect(applyStockMovement(client, { ...args, kind })).rejects.toMatchObject({ code: "ingredient_not_tracked" });
    expect(tx.stockMovement.create).not.toHaveBeenCalled();
  });
  it("preserves tracked stock valuation and append-only history", async () => {
    const { tx, client } = fixture(true);
    await expect(applyStockMovement(client, args, { skipUntracked: true })).resolves.toMatchObject({ movement: { id: "movement" } });
    expect(tx.stockLevel.update).toHaveBeenCalledWith({ where: { ingredientId: "i" }, data: { qtyBase: 8, totalValueCents: 160 } });
    expect(tx.stockMovement.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ qtyBase: -2, valueCents: -40 }) }));
  });
  it("checks tenancy before silently skipping a non-stock ingredient", async () => {
    const { tx, client } = fixture();
    tx.ingredient.findUnique.mockResolvedValue({ restaurantId: "other", active: true, trackInventory: false });
    await expect(applyStockMovement(client, args, { skipUntracked: true })).rejects.toMatchObject({ code: "ingredient_not_found" });
  });
});
