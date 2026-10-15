import { describe, expect, it } from "vitest";
import { costRecipeItems, resolveIngredientCost, type CostContext, type CtxIngredient } from "./recipes";

const context = (ingredient: CtxIngredient): CostContext => new Map([["ingredient", ingredient]]);

describe("ingredient reference prices in recipe costs", () => {
  it("uses the manual price per kg, L or whole unit as a price per 1000 base units", () => {
    const ctx = context({ referencePriceCents: 2500000 });
    expect(resolveIngredientCost(ctx, "ingredient")).toEqual({ costPerBase: 2500, source: "reference" });
    expect(costRecipeItems(ctx, [{ ingredientId: "ingredient", qtyBase: 125, wastePct: 0 }])).toMatchObject({
      costCents: 312500, complete: true,
      lines: [{ lineCostCents: 312500, source: "reference", grossQtyBase: 125 }],
    });
  });

  it("treats an explicitly free ingredient as complete instead of falling back to its supplier", () => {
    const ctx = context({ referencePriceCents: 0, preferred: { lastPriceCents: 500, contentQty: 1000 } });
    expect(resolveIngredientCost(ctx, "ingredient")).toEqual({ costPerBase: 0, source: "reference" });
    expect(costRecipeItems(ctx, [{ ingredientId: "ingredient", qtyBase: 125, wastePct: 20 }])).toMatchObject({ costCents: 0, complete: true });
  });

  it("keeps the real weighted stock cost ahead of a manual reference", () => {
    expect(resolveIngredientCost(context({ stock: { qtyBase: 5000, totalValueCents: 450000 }, referencePriceCents: 120000 }), "ingredient"))
      .toEqual({ costPerBase: 90, source: "stock" });
  });

  it("keeps a complete subrecipe ahead of the output's reference price", () => {
    const ctx: CostContext = new Map([
      ["input", { referencePriceCents: 100000 }],
      ["ingredient", { referencePriceCents: 500000, recipe: { outputQtyBase: 500, items: [{ ingredientId: "input", qtyBase: 1000, wastePct: 0 }] } }],
    ]);
    expect(resolveIngredientCost(ctx, "ingredient")).toEqual({ costPerBase: 200, source: "subrecipe" });
  });

  it("uses the reference after an incomplete subrecipe", () => {
    const ctx = context({ referencePriceCents: 150000, recipe: { outputQtyBase: 1000, items: [{ ingredientId: "missing", qtyBase: 500, wastePct: 0 }] } });
    expect(resolveIngredientCost(ctx, "ingredient")).toEqual({ costPerBase: 150, source: "reference" });
  });

  it.each([undefined, null])("retains supplier fallback when no manual price is set (%s)", (referencePriceCents) => {
    expect(resolveIngredientCost(context({ referencePriceCents, preferred: { lastPriceCents: 480000, contentQty: 4000 } }), "ingredient"))
      .toEqual({ costPerBase: 120, source: "supplier" });
  });

  it("distinguishes an unknown price from an explicitly free price", () => {
    const result = costRecipeItems(context({ referencePriceCents: null }), [{ ingredientId: "ingredient", qtyBase: 1000, wastePct: 0 }]);
    expect(result).toMatchObject({ costCents: 0, complete: false, lines: [{ source: null, lineCostCents: null }] });
  });

  it("keeps precision until the final recipe line and includes waste", () => {
    const result = costRecipeItems(context({ referencePriceCents: 1999 }), [{ ingredientId: "ingredient", qtyBase: 125, wastePct: 20 }]);
    expect(result).toMatchObject({ costCents: 312, complete: true });
  });

  it("propagates known zero prices through nonempty nested subrecipes ahead of suppliers", () => {
    const ctx: CostContext = new Map([
      ["free", { referencePriceCents: 0 }],
      ["prepared", { recipe: { outputQtyBase: 1000, items: [{ ingredientId: "free", qtyBase: 100, wastePct: 0 }] }, preferred: { lastPriceCents: 500000, contentQty: 1000 } }],
      ["ingredient", { recipe: { outputQtyBase: 1000, items: [{ ingredientId: "prepared", qtyBase: 200, wastePct: 0 }] } }],
    ]);
    expect(resolveIngredientCost(ctx, "prepared")).toEqual({ costPerBase: 0, source: "subrecipe" });
    expect(resolveIngredientCost(ctx, "ingredient")).toEqual({ costPerBase: 0, source: "subrecipe" });
    expect(costRecipeItems(ctx, [{ ingredientId: "ingredient", qtyBase: 1000, wastePct: 0 }])).toMatchObject({ costCents: 0, complete: true });
  });

  it("does not mistake an empty subrecipe for a known free cost", () => {
    const recipe = { outputQtyBase: 1000, items: [] };
    expect(resolveIngredientCost(context({ recipe }), "ingredient")).toBeNull();
    expect(resolveIngredientCost(context({ recipe, preferred: { lastPriceCents: 15000, contentQty: 1000 } }), "ingredient")).toEqual({ costPerBase: 15, source: "supplier" });
  });
});
