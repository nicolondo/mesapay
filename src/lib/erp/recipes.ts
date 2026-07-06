// Costeo de recetas (ERP Fase A3) — LÓGICA PURA, sin DB.
//
// El caller (API) precarga el contexto (insumos con stock, precio del
// proveedor preferido y sub-receta si existe) y acá se resuelve la cascada
// de costos y el costo total de cada receta. Nada se persiste: el food
// cost se calcula en vivo con los costos actuales (spec D3).
//
// Cascada por insumo (spec D3):
//   1. Costo promedio del inventario (StockLevel con qty > 0) — el real.
//   2. Sub-receta del insumo: costo recursivo / rendimiento.
//   3. Precio del proveedor preferido: lastPriceCents / contentQty.
//   4. null → "costo incompleto" (nunca $0 mentiroso).
//
// Recursión con tope de profundidad 3 y detección de ciclos.

export const MAX_RECIPE_DEPTH = 3;
export const MAX_WASTE_PCT = 90;

export type CostSource = "stock" | "subrecipe" | "supplier" | null;

export type CtxIngredient = {
  stock?: { qtyBase: number; totalValueCents: number } | null;
  /** Proveedor preferido de la lista de precios (A0). */
  preferred?: { lastPriceCents: number | null; contentQty: number } | null;
  /** Sub-receta del insumo (si es un elaborado). */
  recipe?: {
    outputQtyBase: number | null;
    items: RecipeLine[];
  } | null;
};

export type RecipeLine = {
  ingredientId: string;
  qtyBase: number;
  wastePct: number;
};

export type CostContext = Map<string, CtxIngredient>;

/** Cantidad BRUTA a costear: neto / (1 − merma%). */
export function grossQty(qtyBase: number, wastePct: number): number {
  const pct = Math.min(Math.max(wastePct, 0), MAX_WASTE_PCT);
  return qtyBase / (1 - pct / 100);
}

export type IngredientCost = {
  /** Centavos por unidad base (float — se redondea al costear líneas). */
  costPerBase: number;
  source: CostSource;
} | null;

/**
 * Resuelve el costo por unidad base de un insumo con la cascada D3.
 * `seen` evita ciclos de sub-recetas; `depth` limita la recursión.
 * Devuelve null cuando ninguna fuente aplica (costo incompleto).
 */
export function resolveIngredientCost(
  ctx: CostContext,
  ingredientId: string,
  seen: Set<string> = new Set(),
  depth: number = 0,
): IngredientCost {
  const ing = ctx.get(ingredientId);
  if (!ing) return null;

  // 1. Promedio de inventario.
  if (ing.stock && ing.stock.qtyBase > 0 && ing.stock.totalValueCents > 0) {
    return {
      costPerBase: ing.stock.totalValueCents / ing.stock.qtyBase,
      source: "stock",
    };
  }

  // 2. Sub-receta (recursiva, a prueba de ciclos).
  if (
    ing.recipe &&
    ing.recipe.outputQtyBase &&
    ing.recipe.outputQtyBase > 0 &&
    depth < MAX_RECIPE_DEPTH &&
    !seen.has(ingredientId)
  ) {
    const nextSeen = new Set(seen);
    nextSeen.add(ingredientId);
    const sub = costRecipeItems(ctx, ing.recipe.items, nextSeen, depth + 1);
    if (sub.complete && sub.costCents > 0) {
      return {
        costPerBase: sub.costCents / ing.recipe.outputQtyBase,
        source: "subrecipe",
      };
    }
  }

  // 3. Proveedor preferido.
  if (
    ing.preferred &&
    ing.preferred.lastPriceCents != null &&
    ing.preferred.lastPriceCents > 0 &&
    ing.preferred.contentQty > 0
  ) {
    return {
      costPerBase: ing.preferred.lastPriceCents / ing.preferred.contentQty,
      source: "supplier",
    };
  }

  return null;
}

export type RecipeCostLine = {
  ingredientId: string;
  qtyBase: number;
  wastePct: number;
  grossQtyBase: number;
  /** null = sin fuente de costo (línea incompleta). */
  costPerBase: number | null;
  source: CostSource;
  lineCostCents: number | null;
};

export type RecipeCost = {
  costCents: number;
  /** false si alguna línea no tiene fuente de costo. */
  complete: boolean;
  lines: RecipeCostLine[];
};

/** Costo total de una lista de líneas de receta. */
export function costRecipeItems(
  ctx: CostContext,
  items: RecipeLine[],
  seen: Set<string> = new Set(),
  depth: number = 0,
): RecipeCost {
  const lines: RecipeCostLine[] = [];
  let total = 0;
  let complete = true;

  for (const item of items) {
    const gross = grossQty(item.qtyBase, item.wastePct);
    const cost = resolveIngredientCost(ctx, item.ingredientId, seen, depth);
    const lineCost = cost ? Math.round(gross * cost.costPerBase) : null;
    if (lineCost == null) complete = false;
    else total += lineCost;
    lines.push({
      ingredientId: item.ingredientId,
      qtyBase: item.qtyBase,
      wastePct: item.wastePct,
      grossQtyBase: Math.round(gross),
      costPerBase: cost?.costPerBase ?? null,
      source: cost?.source ?? null,
      lineCostCents: lineCost,
    });
  }

  return { costCents: total, complete, lines };
}

// ── Ingeniería de menú (spec D4) ───────────────────────────────────────────

export type Quadrant = "star" | "plowhorse" | "puzzle" | "dog";

/**
 * Clasificación estándar popularidad × margen:
 *   popular + margen alto  → star (estrella)
 *   popular + margen bajo  → plowhorse (caballito de batalla)
 *   impopular + margen alto→ puzzle (incógnita)
 *   impopular + margen bajo→ dog (perro)
 */
export function engineeringQuadrant(
  unitsSold: number,
  marginCents: number,
  popularityThreshold: number,
  marginThreshold: number,
): Quadrant {
  const popular = unitsSold >= popularityThreshold;
  const highMargin = marginCents >= marginThreshold;
  if (popular && highMargin) return "star";
  if (popular) return "plowhorse";
  if (highMargin) return "puzzle";
  return "dog";
}

/**
 * Umbrales estándar de industria: popularidad = 70% del promedio de
 * unidades por plato; margen = promedio de margen de los platos con datos.
 */
export function engineeringThresholds(
  dishes: Array<{ unitsSold: number; marginCents: number }>,
): { popularityThreshold: number; marginThreshold: number } {
  if (dishes.length === 0) {
    return { popularityThreshold: 0, marginThreshold: 0 };
  }
  const avgUnits =
    dishes.reduce((a, d) => a + d.unitsSold, 0) / dishes.length;
  const avgMargin =
    dishes.reduce((a, d) => a + d.marginCents, 0) / dishes.length;
  return {
    popularityThreshold: avgUnits * 0.7,
    marginThreshold: avgMargin,
  };
}
