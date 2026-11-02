import { describe, expect, it } from "vitest";
import { costRecipeItems, type CostContext } from "./recipes";
import { computeRecipeCostGaps, dishCostGap } from "./recipeCostGaps";

const line = (ingredientId: string, qtyBase: number, wastePct = 0) => ({
  ingredientId,
  qtyBase,
  wastePct,
});

describe("costos incompletos por insumos sin costo", () => {
  it("un plato con todos los insumos costeados no tiene faltantes", () => {
    const ctx: CostContext = new Map([
      ["arroz", { referencePriceCents: 500000 }],
      ["pollo", { stock: { qtyBase: 10000, totalValueCents: 1800000 } }],
    ]);
    const items = [line("arroz", 150), line("pollo", 200, 10)];
    const gap = dishCostGap(ctx, items);
    expect(gap.missing).toEqual([]);
    expect(gap.complete).toBe(true);
    // El costo es EXACTAMENTE el del resto de la app.
    expect(gap.costCents).toBe(costRecipeItems(ctx, items).costCents);
  });

  it("un insumo sin fuente de costo deja el plato incompleto", () => {
    const ctx: CostContext = new Map([
      ["arroz", { referencePriceCents: 500000 }],
      ["cilantro", { referencePriceCents: null }],
    ]);
    const gap = dishCostGap(ctx, [line("arroz", 150), line("cilantro", 5)]);
    expect(gap.complete).toBe(false);
    expect(gap.missing).toEqual([
      { ingredientId: "cilantro", reason: "none", qtyBase: 5, via: [] },
    ]);
    expect(gap.costCents).toBe(75000);
  });

  it("un insumo con precio de referencia en 0 cuenta como costo en cero aunque el costeo lo dé por completo", () => {
    const ctx: CostContext = new Map([
      ["arroz", { referencePriceCents: 500000 }],
      ["sal", { referencePriceCents: 0 }],
    ]);
    const gap = dishCostGap(ctx, [line("arroz", 150), line("sal", 3)]);
    expect(gap.complete).toBe(true);
    expect(gap.missing).toEqual([
      { ingredientId: "sal", reason: "zero", qtyBase: 3, via: [] },
    ]);
  });

  it("una sub-receta con un insumo en 0 contamina al plato y señala la hoja, no el elaborado", () => {
    // Salsa: 1000 g de tomate ($) + 50 g de sal ($0) rinde 1000 g.
    const ctx: CostContext = new Map([
      ["tomate", { referencePriceCents: 400000 }],
      ["sal", { referencePriceCents: 0 }],
      [
        "salsa",
        {
          recipe: {
            outputQtyBase: 1000,
            items: [line("tomate", 1000), line("sal", 50)],
          },
        },
      ],
    ]);
    // El plato lleva 200 g de salsa con 20 % de merma → bruto 250 g.
    const gap = dishCostGap(ctx, [line("salsa", 200, 20)]);
    expect(gap.complete).toBe(true);
    expect(gap.costCents).toBeGreaterThan(0);
    expect(gap.missing).toEqual([
      // 50 g de sal por lote × (250 / 1000) = 12,5 g → 13 g por plato.
      { ingredientId: "sal", reason: "zero", qtyBase: 13, via: ["salsa"] },
    ]);
  });

  it("una sub-receta incompleta propaga la hoja sin costo y el plato queda incompleto", () => {
    const ctx: CostContext = new Map([
      ["tomate", { referencePriceCents: 400000 }],
      ["albahaca", {}],
      [
        "salsa",
        {
          recipe: {
            outputQtyBase: 1000,
            items: [line("tomate", 1000), line("albahaca", 20)],
          },
        },
      ],
    ]);
    const gap = dishCostGap(ctx, [line("salsa", 500)]);
    expect(gap.complete).toBe(false);
    expect(gap.missing).toEqual([
      { ingredientId: "albahaca", reason: "none", qtyBase: 10, via: ["salsa"] },
    ]);
  });

  it("si el elaborado tiene precio de referencia, la sub-receta incompleta no cuenta (el costeo no la usa)", () => {
    const ctx: CostContext = new Map([
      ["albahaca", {}],
      [
        "salsa",
        {
          referencePriceCents: 800000,
          recipe: { outputQtyBase: 1000, items: [line("albahaca", 20)] },
        },
      ],
    ]);
    expect(dishCostGap(ctx, [line("salsa", 500)]).missing).toEqual([]);
  });

  it("un elaborado sin fuente ni sub-receta usable se señala a sí mismo", () => {
    const ctx: CostContext = new Map([
      ["caldo", { recipe: { outputQtyBase: 1000, items: [] } }],
    ]);
    expect(dishCostGap(ctx, [line("caldo", 300)]).missing).toEqual([
      { ingredientId: "caldo", reason: "none", qtyBase: 300, via: [] },
    ]);
  });

  it("un insumo sin costo con cantidad 0 no cuenta", () => {
    const ctx: CostContext = new Map([
      ["arroz", { referencePriceCents: 500000 }],
      ["sal", { referencePriceCents: 0 }],
      ["cilantro", {}],
    ]);
    const gap = dishCostGap(ctx, [
      line("arroz", 150),
      line("sal", 0),
      line("cilantro", 0),
    ]);
    expect(gap.missing).toEqual([]);
  });

  it("un mismo insumo directo y vía sub-receta sale una sola vez con la ruta corta y la cantidad sumada", () => {
    const ctx: CostContext = new Map([
      ["sal", { referencePriceCents: 0 }],
      ["tomate", { referencePriceCents: 400000 }],
      [
        "salsa",
        {
          recipe: {
            outputQtyBase: 1000,
            items: [line("tomate", 1000), line("sal", 100)],
          },
        },
      ],
    ]);
    const gap = dishCostGap(ctx, [line("salsa", 500), line("sal", 2)]);
    expect(gap.missing).toEqual([
      { ingredientId: "sal", reason: "zero", qtyBase: 52, via: [] },
    ]);
  });

  it("agrega por insumo cuántos platos afecta, los que más afectan primero, y sólo devuelve platos incompletos", () => {
    const ctx: CostContext = new Map([
      ["arroz", { referencePriceCents: 500000 }],
      ["sal", { referencePriceCents: 0 }],
      ["cilantro", {}],
    ]);
    const result = computeRecipeCostGaps(ctx, [
      { id: "a", items: [line("arroz", 100), line("sal", 2)] },
      { id: "b", items: [line("arroz", 100)] },
      { id: "c", items: [line("sal", 2), line("cilantro", 5)] },
    ]);
    expect(result.dishes.map((d) => d.id)).toEqual(["a", "c"]);
    expect(result.dishes[1].complete).toBe(false);
    expect(result.ingredients).toEqual([
      { ingredientId: "sal", reason: "zero", usedInCount: 2 },
      { ingredientId: "cilantro", reason: "none", usedInCount: 1 },
    ]);
  });
});
