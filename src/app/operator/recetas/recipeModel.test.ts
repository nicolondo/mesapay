import { describe, expect, it } from "vitest";
import {
  baseToInputQty,
  buildLinesPayload,
  draftFingerprint,
  editLineFromItem,
  formatUnitCost,
  minQtyLabel,
  newEditLine,
  parseLine,
  rankIngredients,
  type EditLine,
  type IngredientOption,
  type ModLine,
} from "./recipeModel";

const ing = (
  id: string,
  name: string,
  measureKind: IngredientOption["measureKind"] = "mass",
  costPerBase: number | null = 16,
): IngredientOption => ({
  id,
  name,
  measureKind,
  costPerBase,
  costSource: costPerBase == null ? null : "reference",
});

const line = (patch: Partial<EditLine> = {}): EditLine => ({
  ...newEditLine(ing("hongos", "Hongos paris")),
  qtyRaw: "180",
  unit: "g",
  wasteRaw: "20",
  ...patch,
});

describe("lectura de una línea", () => {
  it("pasa a unidad base, calcula el bruto y el costo", () => {
    expect(parseLine(line())).toEqual({
      qtyBase: 180,
      wastePct: 20,
      grossBase: 225,
      lineCost: 3600,
    });
  });

  it("acepta coma decimal y la unidad grande", () => {
    const p = parseLine(line({ qtyRaw: "0,25", unit: "kg", wasteRaw: "0" }));
    expect(p).toMatchObject({ qtyBase: 250, grossBase: 250 });
  });

  it("costea con un costo más nuevo que el de la línea", () => {
    expect(parseLine(line({ wasteRaw: "0" }), 20)).toMatchObject({ lineCost: 3600 });
  });

  it("sin costo deja la línea sin costo, no en $0", () => {
    expect(parseLine(line(), null)).toMatchObject({ lineCost: null });
  });

  it("distingue cantidad vacía, demasiado chica y merma inválida", () => {
    expect(parseLine(line({ qtyRaw: "" }))).toBe("qty_invalid");
    expect(parseLine(line({ qtyRaw: "0,5", unit: "g" }))).toBe("qty_too_small");
    expect(parseLine(line({ wasteRaw: "95" }))).toBe("waste_invalid");
  });

  it("«un» admite milésimas (0,002 un de sal)", () => {
    const sal = newEditLine(ing("sal", "Sal", "count", null));
    expect(parseLine({ ...sal, qtyRaw: "0,002" })).toMatchObject({ qtyBase: 2 });
  });
});

describe("precarga desde la receta guardada", () => {
  it("elige la unidad legible y toma el costo vigente del catálogo", () => {
    const catalog = new Map([["arroz", ing("arroz", "Arroz", "mass", 4)]]);
    const l = editLineFromItem(
      { ingredientId: "arroz", qtyBase: 2500, wastePct: 5, ingredientName: "Arroz", measureKind: "mass" },
      catalog,
      undefined,
    );
    expect(l).toMatchObject({ qtyRaw: "2.5", unit: "kg", wasteRaw: "5", costPerBase: 4, costSource: "reference" });
  });

  it("un insumo archivado (fuera del catálogo) conserva el costo de la receta", () => {
    const l = editLineFromItem(
      { ingredientId: "viejo", qtyBase: 10, wastePct: 0, ingredientName: "Viejo", measureKind: "mass" },
      new Map(),
      [{ ingredientId: "viejo", qtyBase: 10, wastePct: 0, grossQtyBase: 10, costPerBase: 7, source: "stock", lineCostCents: 70 }],
    );
    expect(l).toMatchObject({ costPerBase: 7, costSource: "stock" });
  });

  it("baseToInputQty muestra kg/L desde 1000 y «un» con milésimas", () => {
    expect(baseToInputQty(180, "mass")).toEqual({ qty: "180", unit: "g" });
    expect(baseToInputQty(1500, "volume")).toEqual({ qty: "1.5", unit: "L" });
    expect(baseToInputQty(2, "count")).toEqual({ qty: "0.002", unit: "un" });
  });
});

describe("payload del PUT", () => {
  it("arma las líneas en orden", () => {
    const r = buildLinesPayload([line(), line({ qtyRaw: "1", unit: "kg", wasteRaw: "" })], (l, p) => ({
      ingredientId: l.ingredientId,
      qtyBase: p.qtyBase,
      wastePct: p.wastePct,
    }));
    expect(r).toEqual({
      ok: true,
      items: [
        { ingredientId: "hongos", qtyBase: 180, wastePct: 20 },
        { ingredientId: "hongos", qtyBase: 1000, wastePct: 0 },
      ],
    });
  });

  it("se detiene en la primera línea que no se puede leer", () => {
    const bad = line({ qtyRaw: "" });
    const r = buildLinesPayload([line(), bad], (l) => l.ingredientId);
    expect(r).toEqual({ ok: false, error: "qty_invalid", line: bad });
  });
});

describe("cambios sin guardar", () => {
  const notes = "Emplatar caliente";

  it("la misma cantidad escrita distinto no es un cambio", () => {
    const a = line();
    const b = { ...a, qtyRaw: "180,0" };
    expect(draftFingerprint([b], [], notes)).toBe(draftFingerprint([a], [], notes));
  });

  it("cambiar cantidad, merma, signo o notas sí lo es", () => {
    const a = line();
    const base = draftFingerprint([a], [], notes);
    expect(draftFingerprint([{ ...a, qtyRaw: "190" }], [], notes)).not.toBe(base);
    expect(draftFingerprint([{ ...a, wasteRaw: "10" }], [], notes)).not.toBe(base);
    expect(draftFingerprint([a], [], "Otra nota")).not.toBe(base);
    const mod: ModLine = { ...a, modifierId: "m1", optLabel: "Extra", sign: 1 };
    expect(draftFingerprint([a], [mod], notes)).not.toBe(
      draftFingerprint([a], [{ ...mod, sign: -1 }], notes),
    );
  });

  it("agregar una línea vacía ya es un cambio", () => {
    const a = line();
    expect(draftFingerprint([a, line({ qtyRaw: "" })], [], notes)).not.toBe(
      draftFingerprint([a], [], notes),
    );
  });
});

describe("buscador de insumos", () => {
  const options = [
    ing("1", "Aceite de oliva"),
    ing("2", "Azúcar"),
    ing("3", "Sal marina"),
    ing("4", "Salsa de soya"),
    ing("5", "Pimienta sal y limón"),
  ];

  it("sin texto devuelve el catálogo entero en su orden", () => {
    expect(rankIngredients(options, "").map((o) => o.id)).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("primero lo que empieza con lo escrito, luego palabras, luego el resto", () => {
    expect(rankIngredients(options, "sal").map((o) => o.id)).toEqual(["3", "4", "5"]);
    expect(rankIngredients(options, "oliva").map((o) => o.id)).toEqual(["1"]);
  });

  it("ignora tildes y mayúsculas", () => {
    expect(rankIngredients(options, "AZUCAR").map((o) => o.id)).toEqual(["2"]);
  });
});

describe("textos de unidades", () => {
  it("el mínimo de la unidad usa el separador del idioma", () => {
    expect(minQtyLabel("count", "un", "es")).toBe("0,001 un");
    expect(minQtyLabel("count", "un", "en")).toBe("0.001 un");
    expect(minQtyLabel("mass", "kg", "es")).toBe("0,001 kg");
  });

  it("el costo unitario se rotula por kg, L o un", () => {
    // 16 ¢/g = $160/kg; 4 ¢ por milésima de un = $40/un.
    expect(formatUnitCost(16, "mass", "COP", "es")).toMatch(/160\/kg$/);
    expect(formatUnitCost(4, "count", "COP", "es")).toMatch(/40\/un$/);
  });
});
