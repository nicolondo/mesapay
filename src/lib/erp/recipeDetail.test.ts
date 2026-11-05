import { describe, expect, it } from "vitest";
import { embeddedTaxCents } from "./accounting";
import { costRecipeItems, type CostContext } from "./recipes";
import {
  costSharePct,
  foodCostPct,
  foodCostTone,
  grossQtyBase,
  lineCostCents,
  lineCostState,
  menuTaxCents,
  netMenuPriceCents,
  summarizeRecipe,
  unitHint,
  type SummaryLine,
} from "./recipeDetail";

const INC8 = { kind: "inc" as const, pct: 8 };

describe("bruto desde la merma", () => {
  it("180 g netos con 20 % de merma son 225 g brutos", () => {
    expect(grossQtyBase(180, 20)).toBe(225);
  });

  it("sin merma el bruto es el neto", () => {
    expect(grossQtyBase(180, 0)).toBe(180);
  });

  it("redondea a la unidad base", () => {
    // 100 / 0,7 = 142,857…
    expect(grossQtyBase(100, 30)).toBe(143);
  });
});

describe("costo de la línea", () => {
  it("costea el bruto, no el neto", () => {
    // 180 g con 20 % de merma → 225 g × $16/g (1600 ¢/g) = $3.600.
    expect(lineCostCents(180, 20, 1600)).toBe(360000);
  });

  it("sin fuente de costo no hay costo (nunca $0 implícito)", () => {
    expect(lineCostCents(180, 0, null)).toBeNull();
  });

  it("coincide con el costeo del server, línea por línea", () => {
    const ctx: CostContext = new Map([
      ["hongos", { referencePriceCents: 1600000 }],
      ["crema", { stock: { qtyBase: 6820, totalValueCents: 10912000 } }],
      ["sal", {}],
    ]);
    const items = [
      { ingredientId: "hongos", qtyBase: 180, wastePct: 12 },
      { ingredientId: "crema", qtyBase: 90, wastePct: 0 },
      { ingredientId: "sal", qtyBase: 2, wastePct: 0 },
    ];
    const server = costRecipeItems(ctx, items);
    for (const l of server.lines) {
      expect(lineCostCents(l.qtyBase, l.wastePct, l.costPerBase)).toBe(
        l.lineCostCents,
      );
    }
  });
});

describe("estado del costo de la línea", () => {
  it("distingue sin costo, en cero y con costo", () => {
    expect(lineCostState(null)).toBe("none");
    expect(lineCostState(0)).toBe("zero");
    expect(lineCostState(16)).toBe("ok");
  });
});

describe("participación en el costo", () => {
  it("es la parte de la línea sobre el total costeado", () => {
    expect(costSharePct(250, 1000)).toBe(25);
  });

  it("una línea sin costo o un total en 0 no tienen participación", () => {
    expect(costSharePct(null, 1000)).toBeNull();
    expect(costSharePct(0, 0)).toBeNull();
  });
});

describe("precio neto del impuesto embebido", () => {
  it("$42.900 con INC 8 % deja $39.722", () => {
    expect(menuTaxCents(4290000, INC8)).toBe(317778);
    expect(netMenuPriceCents(4290000, INC8)).toBe(3972222);
  });

  it("usa la misma fórmula que la contabilidad", () => {
    expect(menuTaxCents(5200000, { kind: "iva", pct: 19 })).toBe(
      embeddedTaxCents(5200000, 19),
    );
  });

  it("sin impuesto el neto es el precio de carta", () => {
    expect(netMenuPriceCents(4290000, { kind: "none", pct: 0 })).toBe(4290000);
    expect(netMenuPriceCents(4290000, null)).toBe(4290000);
  });
});

describe("food cost", () => {
  it("es costo / precio neto", () => {
    expect(foodCostPct(1191667, 3972222, true)).toBeCloseTo(30, 1);
  });

  it("no se mide con costo incompleto ni con precio en 0", () => {
    expect(foodCostPct(1000, 4000, false)).toBeNull();
    expect(foodCostPct(1000, 0, true)).toBeNull();
  });

  it("semáforo: hasta 30 % bien, hasta 40 % atención, más es alto", () => {
    expect(foodCostTone(30)).toBe("ok");
    expect(foodCostTone(30.1)).toBe("warn");
    expect(foodCostTone(40)).toBe("warn");
    expect(foodCostTone(40.1)).toBe("high");
  });
});

describe("resumen de la receta", () => {
  const ok = (cents: number, perBase = 10): SummaryLine => ({
    valid: true,
    costPerBase: perBase,
    lineCostCents: cents,
  });

  it("completa: total, food cost y margen sobre el precio neto", () => {
    const s = summarizeRecipe([ok(800000), ok(391667)], 4290000, INC8);
    expect(s.complete).toBe(true);
    expect(s.totalCents).toBe(1191667);
    expect(s.netPriceCents).toBe(3972222);
    expect(s.taxCents).toBe(317778);
    expect(s.foodCostPct).toBeCloseTo(30, 1);
    expect(s.marginCents).toBe(3972222 - 1191667);
    expect(s.missingCount).toBe(0);
  });

  it("un insumo sin costo deja el total parcial y sin food cost ni margen", () => {
    const s = summarizeRecipe(
      [ok(800000), { valid: true, costPerBase: null, lineCostCents: null }],
      4290000,
      INC8,
    );
    expect(s.complete).toBe(false);
    expect(s.missingCount).toBe(1);
    expect(s.totalCents).toBe(800000);
    expect(s.foodCostPct).toBeNull();
    expect(s.marginCents).toBeNull();
  });

  it("un insumo en $0 cuenta aparte pero el costo sigue completo", () => {
    const s = summarizeRecipe(
      [ok(800000), { valid: true, costPerBase: 0, lineCostCents: 0 }],
      4290000,
      INC8,
    );
    expect(s.complete).toBe(true);
    expect(s.zeroCount).toBe(1);
    expect(s.missingCount).toBe(0);
  });

  it("una línea que no se puede leer deja la receta incompleta", () => {
    const s = summarizeRecipe(
      [ok(800000), { valid: false, costPerBase: 10, lineCostCents: null }],
      4290000,
      INC8,
    );
    expect(s.complete).toBe(false);
    expect(s.invalidCount).toBe(1);
    expect(s.missingCount).toBe(0);
    expect(s.totalCents).toBe(800000);
  });

  it("sin líneas no hay costo completo", () => {
    const s = summarizeRecipe([], 4290000, INC8);
    expect(s.complete).toBe(false);
    expect(s.foodCostPct).toBeNull();
  });
});

describe("aviso de unidad sospechosa", () => {
  it("0,002 un de sal sugiere revisar la unidad del insumo", () => {
    expect(unitHint("count", 2)).toBe("tiny_count");
  });

  it("fracciones razonables de unidad no avisan", () => {
    expect(unitHint("count", 500)).toBeNull(); // ½ limón
    expect(unitHint("count", 40)).toBeNull(); // un trago de una botella
    expect(unitHint("count", 10)).toBeNull(); // 0,01 un
  });

  it("peso y volumen no avisan", () => {
    expect(unitHint("mass", 2)).toBeNull();
    expect(unitHint("volume", 2)).toBeNull();
  });
});
