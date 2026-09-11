import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
const movement = vi.hoisted(() => vi.fn());
vi.mock("@/lib/erp/stock", () => ({ applyStockMovement: movement }));
import { runProduction } from "./production";

function fixture() {
  const tx = {
    recipe: { findFirst: vi.fn().mockResolvedValue({ outputQtyBase: 10, items: [{ ingredientId: "tracked", qtyBase: 3, wastePct: 0 }, { ingredientId: "untracked", qtyBase: 4, wastePct: 0 }] }) },
    productionBatch: { create: vi.fn().mockResolvedValue({ id: "batch" }), update: vi.fn().mockImplementation(({ data }) => ({ id: "batch", ...data })) },
  };
  return { tx, client: tx as unknown as Prisma.TransactionClient };
}
beforeEach(() => {
  movement.mockReset();
  movement.mockImplementation((_tx, args) => args.ingredientId === "untracked" ? null : { movement: { valueCents: -60 } });
});
describe("production with non-stock ingredients", () => {
  it("skips stock for untracked inputs and persists partial cost for history", async () => {
    const { tx, client } = fixture();
    const result = await runProduction(client, { restaurantId: "r", outputIngredientId: "output", outputQtyBase: 20 });
    expect(result).toEqual({ batch: { id: "batch", costCents: 60, partialCost: true }, partialCost: true });
    expect(movement).toHaveBeenCalledWith(client, expect.objectContaining({ ingredientId: "untracked", kind: "production_out", qtyBase: 8 }), { allowInactive: true, skipUntracked: true });
    expect(movement).toHaveBeenCalledWith(client, expect.objectContaining({ ingredientId: "output", kind: "production_in", totalCostCents: 60 }), { allowInactive: true });
    expect(tx.productionBatch.update).toHaveBeenCalledWith(expect.objectContaining({ data: { costCents: 60, partialCost: true } }));
  });
  it("keeps complete cost for fully tracked valued inputs", async () => {
    const { client } = fixture();
    movement.mockResolvedValue({ movement: { valueCents: -60 } });
    await expect(runProduction(client, { restaurantId: "r", outputIngredientId: "output", outputQtyBase: 20 })).resolves.toMatchObject({ batch: { costCents: 120, partialCost: false }, partialCost: false });
  });
});
