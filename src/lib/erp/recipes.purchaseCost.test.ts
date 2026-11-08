import { describe, expect, it } from "vitest";
import { costRecipeItems, resolveIngredientCost, type CostContext, type CtxIngredient } from "./recipes";

const purchase = { qtyBase: 2000, totalCostCents: 2380000 };
const context = (extra: Partial<CtxIngredient> = {}): CostContext => new Map([["ingredient", { purchase, ...extra }]]);

describe("received purchase fallback in recipe cost", () => {
  it("costs an untracked or depleted ingredient even without a supplier presentation", () => {
    for (const stock of [null, { qtyBase: 0, totalValueCents: 0 }, { qtyBase: -100, totalValueCents: -200 }]) {
      expect(resolveIngredientCost(context({ stock }), "ingredient")).toEqual({ costPerBase: 1190, source: "purchase" });
      expect(costRecipeItems(context({ stock }), [{ ingredientId: "ingredient", qtyBase: 200, wastePct: 20 }]))
        .toMatchObject({ complete: true, costCents: 297500 });
    }
  });

  it("preserves weighted stock and explicit manual prices, including zero", () => {
    expect(resolveIngredientCost(context({ stock: { qtyBase: 2000, totalValueCents: 2400000 } }), "ingredient"))
      .toEqual({ source: "stock", costPerBase: 1200 });
    expect(resolveIngredientCost(context({ referencePriceCents: 1000000 }), "ingredient"))
      .toEqual({ source: "reference", costPerBase: 1000 });
    expect(resolveIngredientCost(context({ referencePriceCents: 0 }), "ingredient"))
      .toEqual({ source: "reference", costPerBase: 0 });
  });

  it("prefers an actual received purchase over the supplier list and propagates through subrecipes", () => {
    const ctx = context({ preferred: { contentQty: 1000, lastPriceCents: 500000 } });
    ctx.set("prepared", { purchase: { qtyBase: 1000, totalCostCents: 1 }, recipe: {
      outputQtyBase: 1000, items: [{ ingredientId: "ingredient", qtyBase: 500, wastePct: 0 }],
    } });
    expect(resolveIngredientCost(ctx, "ingredient")).toEqual({ source: "purchase", costPerBase: 1190 });
    expect(resolveIngredientCost(ctx, "prepared")).toEqual({ source: "subrecipe", costPerBase: 595 });
  });

  it.each([
    null, { qtyBase: 0, totalCostCents: 10 }, { qtyBase: -1, totalCostCents: 10 },
    { qtyBase: 10, totalCostCents: -1 }, { qtyBase: 10, totalCostCents: Number.NaN },
    { qtyBase: Number.POSITIVE_INFINITY, totalCostCents: 10 },
  ])("ignores an invalid or missing purchase source (%j)", (purchase) => {
    expect(resolveIngredientCost(context({ purchase }), "ingredient")).toBeNull();
  });

  it("accepts an explicitly free received purchase without masking it with a list price", () => {
    expect(resolveIngredientCost(context({ purchase: { qtyBase: 1000, totalCostCents: 0 }, preferred: { contentQty: 1000, lastPriceCents: 500000 } }), "ingredient"))
      .toEqual({ source: "purchase", costPerBase: 0 });
  });
});
