// Costos incompletos de las recetas — LÓGICA PURA, sin DB.
//
// Un plato tiene "costo incompleto" cuando algún insumo de su receta (directo
// o dentro de una sub-receta que el costeo usa) queda SIN costo (ninguna
// fuente de la cascada D3) o resuelve a CERO (precio de referencia en 0, o
// una sub-receta cuyo lote cuesta 0). En ambos casos el costo del plato sale
// por debajo del real y el margen engaña.
//
// El costo del plato se calcula con `costRecipeItems` (la misma función que
// usa el resto de la app): acá sólo se identifican las hojas culpables y por
// qué cadena de sub-recetas llegan al plato.

import {
  costRecipeItems,
  grossQty,
  MAX_RECIPE_DEPTH,
  resolveIngredientCost,
  type CostContext,
  type RecipeLine,
} from "@/lib/erp/recipes";

/** "none" = sin fuente de costo · "zero" = resuelve a 0. */
export type CostGapReason = "none" | "zero";

export type MissingCostLine = {
  /** Insumo hoja sin costo (donde hay que corregir). */
  ingredientId: string;
  reason: CostGapReason;
  /**
   * Cantidad NETA efectiva del insumo por plato, en su unidad base. Para una
   * línea directa es la cantidad de la receta; a través de sub-recetas se
   * escala por bruto / rendimiento de cada nivel.
   */
  qtyBase: number;
  /** Ids de las sub-recetas por las que llega al plato ([] = línea directa). */
  via: string[];
};

export type DishCostGap = {
  /** Mismo costo que calcula el resto de la app (`costRecipeItems`). */
  costCents: number;
  /** false si alguna línea no tiene fuente de costo (semántica existente). */
  complete: boolean;
  /** Insumos sin costo o en cero, uno por insumo. Vacío = costo completo. */
  missing: MissingCostLine[];
};

/** ¿La cascada usaría esta sub-receta en este punto de la recursión? */
function usableSubRecipe(
  ctx: CostContext,
  ingredientId: string,
  seen: Set<string>,
  depth: number,
) {
  const recipe = ctx.get(ingredientId)?.recipe;
  if (
    recipe &&
    recipe.outputQtyBase &&
    recipe.outputQtyBase > 0 &&
    recipe.items.length > 0 &&
    depth < MAX_RECIPE_DEPTH &&
    !seen.has(ingredientId)
  ) {
    return { outputQtyBase: recipe.outputQtyBase, items: recipe.items };
  }
  return null;
}

/**
 * Recorre las líneas (y las sub-recetas que el costeo realmente usa) y
 * devuelve las hojas sin costo o en cero. Las líneas con cantidad 0 no
 * cuentan: no aportan al costo aunque el insumo no lo tenga.
 */
function collectMissing(
  ctx: CostContext,
  items: RecipeLine[],
  scale: number,
  via: string[],
  seen: Set<string>,
  depth: number,
  out: MissingCostLine[],
): void {
  for (const item of items) {
    if (item.qtyBase <= 0) continue;
    const cost = resolveIngredientCost(ctx, item.ingredientId, seen, depth);
    const push = (reason: CostGapReason) =>
      out.push({
        ingredientId: item.ingredientId,
        reason,
        qtyBase: Math.max(1, Math.round(item.qtyBase * scale)),
        via,
      });

    // Hojas dentro de la sub-receta del insumo (si el costeo la usa): el
    // bruto de esta línea sobre el rendimiento del lote escala cada hoja.
    const digInto = (): MissingCostLine[] => {
      const sub = usableSubRecipe(ctx, item.ingredientId, seen, depth);
      if (!sub) return [];
      const nextSeen = new Set(seen);
      nextSeen.add(item.ingredientId);
      const leaves: MissingCostLine[] = [];
      collectMissing(
        ctx,
        sub.items,
        (scale * grossQty(item.qtyBase, item.wastePct)) / sub.outputQtyBase,
        [...via, item.ingredientId],
        nextSeen,
        depth + 1,
        leaves,
      );
      return leaves;
    };

    if (cost === null) {
      // Sin fuente: si tiene sub-receta usable, la culpa es de sus hojas
      // (la sub-receta quedó incompleta); si no, el insumo mismo.
      const leaves = digInto();
      if (leaves.length > 0) out.push(...leaves);
      else push("none");
    } else if (cost.source === "subrecipe") {
      // Costeado por sub-receta: aunque el lote tenga costo > 0, una hoja en
      // cero lo deja por debajo del real. Si el lote entero resolvió a 0 sin
      // hojas culpables (redondeo), se señala el elaborado.
      const leaves = digInto();
      if (leaves.length > 0) out.push(...leaves);
      else if (cost.costPerBase === 0) push("zero");
    } else if (cost.costPerBase === 0) {
      push("zero");
    }
  }
}

/** Un insumo por plato: se suman cantidades y se prefiere la ruta más corta. */
function dedupe(lines: MissingCostLine[]): MissingCostLine[] {
  const byId = new Map<string, MissingCostLine>();
  for (const l of lines) {
    const prev = byId.get(l.ingredientId);
    if (!prev) {
      byId.set(l.ingredientId, { ...l });
      continue;
    }
    prev.qtyBase += l.qtyBase;
    if (l.via.length < prev.via.length) prev.via = l.via;
    // "none" pesa más que "zero": sin fuente es el caso más grave.
    if (l.reason === "none") prev.reason = "none";
  }
  return [...byId.values()];
}

/** Costo del plato (igual que el resto de la app) + insumos sin costo. */
export function dishCostGap(ctx: CostContext, items: RecipeLine[]): DishCostGap {
  const cost = costRecipeItems(ctx, items);
  const missing: MissingCostLine[] = [];
  collectMissing(ctx, items, 1, [], new Set(), 0, missing);
  return { costCents: cost.costCents, complete: cost.complete, missing: dedupe(missing) };
}

export type IngredientWithoutCost = {
  ingredientId: string;
  reason: CostGapReason;
  /** Platos (con receta) en los que aparece sin costo. */
  usedInCount: number;
};

export type RecipeCostGaps<TDish> = {
  /** Sólo los platos con costo incompleto, en el orden recibido. */
  dishes: Array<TDish & DishCostGap>;
  /** Insumos culpables, los que afectan más platos primero. */
  ingredients: IngredientWithoutCost[];
};

/**
 * Costos incompletos de toda la carta: por plato, las hojas sin costo; y el
 * agregado por insumo para corregir primero lo que más platos arregla.
 */
export function computeRecipeCostGaps<TDish extends { items: RecipeLine[] }>(
  ctx: CostContext,
  dishes: TDish[],
): RecipeCostGaps<TDish> {
  const out: Array<TDish & DishCostGap> = [];
  const usage = new Map<string, IngredientWithoutCost>();
  for (const dish of dishes) {
    const gap = dishCostGap(ctx, dish.items);
    if (gap.missing.length === 0) continue;
    out.push({ ...dish, ...gap });
    for (const m of gap.missing) {
      const prev = usage.get(m.ingredientId);
      if (prev) {
        prev.usedInCount++;
        if (m.reason === "none") prev.reason = "none";
      } else {
        usage.set(m.ingredientId, {
          ingredientId: m.ingredientId,
          reason: m.reason,
          usedInCount: 1,
        });
      }
    }
  }
  return {
    dishes: out,
    ingredients: [...usage.values()].sort(
      (a, b) => b.usedInCount - a.usedInCount,
    ),
  };
}
