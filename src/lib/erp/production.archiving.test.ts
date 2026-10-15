import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

const mocks = vi.hoisted(() => ({ lock: vi.fn(), movement: vi.fn() }));
vi.mock("@/lib/orderLock", () => ({ lockStock: mocks.lock }));
vi.mock("@/lib/erp/stock", () => ({ applyStockMovement: mocks.movement }));
import { runProduction } from "./production";

function fixture() {
  const tx = {
    ingredient: { findUnique: vi.fn().mockResolvedValue({ restaurantId: "restaurant", active: true }) },
    recipe: { findFirst: vi.fn().mockResolvedValue({ outputQtyBase: 10, items: [{ ingredientId: "archived-input", qtyBase: 3, wastePct: 0 }] }) },
    productionBatch: {
      create: vi.fn().mockResolvedValue({ id: "batch" }),
      update: vi.fn().mockImplementation(({ data }) => ({ id: "batch", ...data })),
    },
  };
  return { tx, client: tx as unknown as Prisma.TransactionClient };
}

const args = { restaurantId: "restaurant", outputIngredientId: "output", outputQtyBase: 20 };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.movement.mockResolvedValue({ movement: { valueCents: -60 } });
});

describe("archived ingredients in production", () => {
  it("rejects an archived output before creating a batch or consuming its inputs", async () => {
    const { tx, client } = fixture();
    tx.ingredient.findUnique.mockResolvedValue({ restaurantId: "restaurant", active: false });

    await expect(runProduction(client, args)).rejects.toMatchObject({ code: "ingredient_inactive" });

    expect(tx.productionBatch.create).not.toHaveBeenCalled();
    expect(mocks.movement).not.toHaveBeenCalled();
  });

  it("checks the output after the stock lock so a concurrent archive is respected", async () => {
    const { tx, client } = fixture();
    mocks.lock.mockImplementation(async () => {
      tx.ingredient.findUnique.mockResolvedValue({ restaurantId: "restaurant", active: false });
    });

    await expect(runProduction(client, args)).rejects.toMatchObject({ code: "ingredient_inactive" });

    expect(mocks.lock).toHaveBeenCalledWith(client, "restaurant");
    expect(tx.productionBatch.create).not.toHaveBeenCalled();
  });

  it("does not produce another restaurant's ingredient", async () => {
    const { tx, client } = fixture();
    tx.ingredient.findUnique.mockResolvedValue({ restaurantId: "other", active: true });

    await expect(runProduction(client, args)).rejects.toMatchObject({ code: "ingredient_not_found" });
    expect(tx.productionBatch.create).not.toHaveBeenCalled();
    expect(mocks.movement).not.toHaveBeenCalled();
  });

  it("retains consumption of an archived ingredient already used by an active output's recipe", async () => {
    const { tx, client } = fixture();

    await expect(runProduction(client, args)).resolves.toMatchObject({ batch: { costCents: 60, partialCost: false } });

    expect(mocks.movement).toHaveBeenCalledWith(client, expect.objectContaining({
      ingredientId: "archived-input", kind: "production_out", qtyBase: 6,
    }), { allowInactive: true, skipUntracked: true });
    expect(tx.ingredient.findUnique).toHaveBeenCalledTimes(1);
    expect(tx.productionBatch.create).toHaveBeenCalledTimes(1);
  });
});
