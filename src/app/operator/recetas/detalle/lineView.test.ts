import { describe, expect, it } from "vitest";
import { newEditLine, type EditLine, type IngredientOption, type ModLine } from "../recipeModel";
import { buildLineViews, resolveCost, type ResolvedCost } from "./lineView";

const INC8 = { kind: "inc" as const, pct: 8 };

const ing = (
  id: string,
  measureKind: IngredientOption["measureKind"],
  costPerBase: number | null,
): IngredientOption => ({
  id,
  name: id,
  measureKind,
  costPerBase,
  costSource: costPerBase == null ? null : "stock",
});

const lineOf = (o: IngredientOption, qtyRaw: string, unit: string, wasteRaw = "0"): EditLine => ({
  ...newEditLine(o),
  qtyRaw,
  unit,
  wasteRaw,
});

describe("costo vigente de una línea", () => {
  const arroz = ing("arroz", "mass", 4);
  const l = lineOf(arroz, "100", "g");

  it("lo recién corregido manda sobre el catálogo", () => {
    const overrides = new Map<string, ResolvedCost>([
      ["arroz", { costPerBase: 5, costSource: "reference" }],
    ]);
    expect(resolveCost(l, overrides, new Map([["arroz", arroz]]))).toEqual({
      costPerBase: 5,
      costSource: "reference",
    });
  });

  it("el catálogo recargado manda sobre lo que traía la línea", () => {
    const fresh = { ...arroz, costPerBase: 6 };
    expect(resolveCost(l, new Map(), new Map([["arroz", fresh]])).costPerBase).toBe(6);
  });

  it("un insumo fuera del catálogo usa lo que traía la línea", () => {
    expect(resolveCost(l, new Map(), new Map())).toEqual({
      costPerBase: 4,
      costSource: "stock",
    });
  });
});

describe("vistas de las líneas y resumen", () => {
  const catalog = new Map<string, IngredientOption>();
  const costOf = (l: EditLine) => resolveCost(l, new Map(), catalog);

  it("costo por línea, participación y food cost sobre el precio neto", () => {
    const a = ing("hongos", "mass", 16);
    const b = ing("crema", "volume", 16);
    const { views, summary } = buildLineViews(
      [lineOf(a, "180", "g", "20"), lineOf(b, "75", "ml")],
      costOf,
      4290000,
      INC8,
    );
    expect(views.map((v) => v.lineCost)).toEqual([3600, 1200]);
    expect(views.map((v) => v.share)).toEqual([75, 25]);
    expect(summary).toMatchObject({ totalCents: 4800, complete: true, netPriceCents: 3972222 });
    expect(summary.foodCostPct).toBeCloseTo((4800 / 3972222) * 100, 6);
  });

  it("marca la línea sin costo y deja el resto con su participación", () => {
    const a = ing("hongos", "mass", 16);
    const trufa = ing("trufa", "volume", null);
    const { views, summary } = buildLineViews(
      [lineOf(a, "100", "g"), lineOf(trufa, "5", "ml")],
      costOf,
      5200000,
      INC8,
    );
    expect(views[1]).toMatchObject({ state: "none", lineCost: null, share: null });
    expect(views[0]!.share).toBe(100);
    expect(summary).toMatchObject({ missingCount: 1, complete: false, foodCostPct: null });
  });

  it("avisa la cantidad diminuta en «un» y no en las fracciones razonables", () => {
    const sal = ing("sal", "count", null);
    const limon = ing("limon", "count", 40);
    const { views } = buildLineViews(
      [lineOf(sal, "0,002", "un"), lineOf(limon, "0,5", "un")],
      costOf,
      0,
      null,
    );
    expect(views.map((v) => v.hint)).toEqual(["tiny_count", null]);
  });

  it("una línea que no se lee lleva su error y no suma", () => {
    const a = ing("hongos", "mass", 16);
    const { views, summary } = buildLineViews([lineOf(a, "", "g")], costOf, 4290000, INC8);
    expect(views[0]).toMatchObject({ error: "qty_invalid", lineCost: null, hint: null });
    expect(summary).toMatchObject({ invalidCount: 1, complete: false, totalCents: 0 });
  });

  it("las líneas de modificador que quitan restan", () => {
    const queso = ing("queso", "mass", 10);
    const mods: ModLine[] = [
      { ...lineOf(queso, "30", "g"), modifierId: "m", optLabel: "Extra", sign: 1 },
      { ...lineOf(queso, "10", "g"), modifierId: "m", optLabel: "Sin", sign: -1 },
    ];
    const { views, summary } = buildLineViews(mods, costOf, 0, null);
    expect(views.map((v) => v.lineCost)).toEqual([300, -100]);
    expect(summary.totalCents).toBe(200);
  });
});
