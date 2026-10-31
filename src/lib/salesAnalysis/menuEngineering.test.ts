import { describe, expect, it } from "vitest";
import { buildMenuEngineering, type RecipeCostInfo } from "./menuEngineering";

const product = (id: string, units: number, netCents: number) => ({ menuItemId: id, name: id, units, netCents });

describe("ingeniería de menú con costo confiable", () => {
  // Promedio de unidades = 40 → popular desde 28. Margen unitario promedio con datos.
  const products = [
    product("estrella", 80, 80 * 40_000_00), // precio neto 40.000, costo 12.000 → margen 28.000
    product("caballo", 50, 50 * 20_000_00), // 20.000 − 14.000 = 6.000
    product("rompecabezas", 10, 10 * 50_000_00), // 50.000 − 15.000 = 35.000
    product("perro", 20, 20 * 15_000_00), // 15.000 − 12.000 = 3.000
    product("sin-receta", 30, 30 * 10_000_00),
    product("incompleto", 5, 5 * 10_000_00),
    product("cero", 5, 5 * 10_000_00),
  ];
  const costs = new Map<string, RecipeCostInfo>([
    ["estrella", { costCents: 12_000_00, complete: true }],
    ["caballo", { costCents: 14_000_00, complete: true }],
    ["rompecabezas", { costCents: 15_000_00, complete: true }],
    ["perro", { costCents: 12_000_00, complete: true }],
    ["incompleto", { costCents: 2_000_00, complete: false }],
    ["cero", { costCents: 0, complete: true }],
  ]);
  const m = buildMenuEngineering(products, costs);

  it("clasifica en estrella, caballo, rompecabezas y perro con los umbrales de Recetas", () => {
    expect(m.popularityThreshold).toBeCloseTo((160 / 4) * 0.7);
    expect(m.marginThreshold).toBeCloseTo((28_000_00 + 6_000_00 + 35_000_00 + 3_000_00) / 4);
    const q = Object.fromEntries(m.dishes.map((d) => [d.menuItemId, d.quadrant]));
    expect(q).toEqual({ estrella: "star", caballo: "plowhorse", rompecabezas: "puzzle", perro: "dog" });
  });

  it("margen sobre el precio NETO real del período", () => {
    const star = m.dishes.find((d) => d.menuItemId === "estrella")!;
    expect(star.unitNetCents).toBe(40_000_00);
    expect(star.unitMarginCents).toBe(28_000_00);
    expect(star.marginPct).toBeCloseTo(0.7);
    expect(star.contributionCents).toBe(80 * 28_000_00);
  });

  it("deja fuera, con el motivo, lo que no tiene costo confiable", () => {
    expect(Object.fromEntries(m.unreliable.map((u) => [u.menuItemId, u.reason]))).toEqual({
      "sin-receta": "no_recipe",
      incompleto: "incomplete_cost",
      cero: "zero_cost",
    });
  });

  it("cobertura = parte de la venta con costo confiable", () => {
    const total = products.reduce((s, p) => s + p.netCents, 0);
    const covered = (80 * 40_000_00) + (50 * 20_000_00) + (10 * 50_000_00) + (20 * 15_000_00);
    expect(m.coverage).toBeCloseTo(covered / total);
    expect(m.enough).toBe(true);
  });

  it("con menos de tres platos costeados no hay matriz", () => {
    const few = buildMenuEngineering(products.slice(0, 2), costs);
    expect(few.enough).toBe(false);
    expect(buildMenuEngineering([], new Map()).coverage).toBe(0);
  });
});
