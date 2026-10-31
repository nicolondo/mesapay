// Margen e ingeniería de menú del análisis de ventas — LÓGICA PURA.
//
// ¿Es confiable el costo por plato? Sólo cuando hay RECETA y su costo está
// COMPLETO (cada insumo tiene una fuente de costo en la cascada de
// `erp/recipes.ts`: promedio del inventario, sub-receta, referencia manual o
// proveedor preferido). Un plato sin receta, con un insumo sin costo o con
// costo cero queda FUERA del margen y se explica por qué: nunca se inventa un
// costo cero implícito.
//
// Límites que el dueño tiene que conocer (se muestran en pantalla):
//  · el costo es el ACTUAL de la receta (no el del día de cada venta);
//  · no incluye los insumos que agregan los modificadores;
//  · el precio es el NETO real del período (sin impuesto y con descuentos),
//    no el de la carta.
//
// La matriz (popularidad × margen) usa los mismos umbrales que la pestaña
// «Ingeniería» de Recetas: popular = al menos el 70 % del promedio de
// unidades por plato; margen alto = al menos el margen unitario promedio.
import { engineeringQuadrant, engineeringThresholds, type Quadrant } from "@/lib/erp/recipes";

export type ProductSales = {
  menuItemId: string;
  name: string;
  units: number;
  netCents: number;
};

/** Costo actual de la receta: null = sin receta; complete=false = falta costo. */
export type RecipeCostInfo = { costCents: number; complete: boolean } | null;

export type UnreliableReason = "no_recipe" | "incomplete_cost" | "zero_cost";

export type EngineeredDish = ProductSales & {
  unitNetCents: number;
  unitCostCents: number;
  unitMarginCents: number;
  /** Margen / precio neto unitario. */
  marginPct: number;
  /** Contribución total = margen unitario × unidades. */
  contributionCents: number;
  quadrant: Quadrant;
};

export type MenuEngineering = {
  dishes: EngineeredDish[];
  unreliable: (ProductSales & { reason: UnreliableReason })[];
  popularityThreshold: number;
  marginThreshold: number;
  /** Parte de la venta de carta con costo confiable (0–1). */
  coverage: number;
  /** ¿Hay suficientes platos con costo para mostrar la matriz? */
  enough: boolean;
};

/** Platos con costo confiable necesarios para que la matriz diga algo. */
export const MIN_ENGINEERED_DISHES = 3;
/** Por debajo de esta cobertura se avisa que el margen es parcial. */
export const LOW_COVERAGE = 0.5;

export function buildMenuEngineering(
  products: readonly ProductSales[],
  costs: ReadonlyMap<string, RecipeCostInfo>,
): MenuEngineering {
  const sold = products.filter((p) => p.units > 0);
  const totalNet = sold.reduce((s, p) => s + Math.max(0, p.netCents), 0);
  const reliable: Omit<EngineeredDish, "quadrant">[] = [];
  const unreliable: MenuEngineering["unreliable"] = [];
  for (const p of sold) {
    const cost = costs.get(p.menuItemId) ?? null;
    if (!cost) {
      unreliable.push({ ...p, reason: "no_recipe" });
      continue;
    }
    if (!cost.complete) {
      unreliable.push({ ...p, reason: "incomplete_cost" });
      continue;
    }
    if (cost.costCents <= 0) {
      unreliable.push({ ...p, reason: "zero_cost" });
      continue;
    }
    const unitNetCents = p.netCents / p.units;
    const unitMarginCents = unitNetCents - cost.costCents;
    reliable.push({
      ...p,
      unitNetCents,
      unitCostCents: cost.costCents,
      unitMarginCents,
      marginPct: unitNetCents > 0 ? unitMarginCents / unitNetCents : 0,
      contributionCents: unitMarginCents * p.units,
    });
  }
  const { popularityThreshold, marginThreshold } = engineeringThresholds(
    reliable.map((d) => ({ unitsSold: d.units, marginCents: d.unitMarginCents })),
  );
  const dishes = reliable
    .map((d) => ({
      ...d,
      quadrant: engineeringQuadrant(d.units, d.unitMarginCents, popularityThreshold, marginThreshold),
    }))
    .sort((a, b) => b.contributionCents - a.contributionCents);
  const coveredNet = reliable.reduce((s, d) => s + Math.max(0, d.netCents), 0);
  return {
    dishes,
    unreliable: unreliable.sort((a, b) => b.netCents - a.netCents),
    popularityThreshold,
    marginThreshold,
    coverage: totalNet > 0 ? coveredNet / totalNet : 0,
    enough: dishes.length >= MIN_ENGINEERED_DISHES,
  };
}
