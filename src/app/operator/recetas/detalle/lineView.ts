// Vista de cada línea del detalle de receta: lo tecleado ya interpretado
// (unidad base, bruto), el costo vigente con su fuente, su participación en
// el total y los avisos (sin costo, unidad sospechosa). Pura, sin React.

import {
  costSharePct,
  lineCostState,
  summarizeRecipe,
  unitHint,
  type LineCostState,
  type MenuTax,
  type RecipeSummary,
  type UnitHint,
} from "@/lib/erp/recipeDetail";
import {
  isParseError,
  parseLine,
  type CostSource,
  type EditLine,
  type IngredientOption,
  type ParseError,
  type ParsedLine,
} from "../recipeModel";

/** Costo vigente de un insumo (cascada D3 ya resuelta). */
export type ResolvedCost = { costPerBase: number | null; costSource: CostSource };

export type LineView<L extends EditLine = EditLine> = {
  line: L;
  parsed: ParsedLine;
  /** Error de lectura, o null si la línea se lee bien. */
  error: ParseError | null;
  costPerBase: number | null;
  costSource: CostSource;
  state: LineCostState;
  /** Costo de la línea con su signo (las de modificador que quitan restan). */
  lineCost: number | null;
  /** % del costo total de la receta (null sin costo o total en 0). */
  share: number | null;
  hint: UnitHint | null;
};

/**
 * El costo más nuevo que se conoce de un insumo: el que se acaba de corregir
 * en esta pantalla, el del catálogo recién cargado o, para un insumo que ya
 * no está en el catálogo (archivado), el que traía la línea.
 */
export function resolveCost(
  line: EditLine,
  overrides: ReadonlyMap<string, ResolvedCost>,
  catalog: ReadonlyMap<string, IngredientOption>,
): ResolvedCost {
  const o = overrides.get(line.ingredientId);
  if (o) return o;
  const c = catalog.get(line.ingredientId);
  if (c) return { costPerBase: c.costPerBase, costSource: c.costSource };
  return { costPerBase: line.costPerBase, costSource: line.costSource };
}

/** Vistas de las líneas + resumen (costo, food cost, margen, faltantes). */
export function buildLineViews<L extends EditLine>(
  lines: L[],
  costOf: (l: L) => ResolvedCost,
  priceCents: number,
  tax: MenuTax | null,
): { views: LineView<L>[]; summary: RecipeSummary } {
  const partial = lines.map((line) => {
    const { costPerBase, costSource } = costOf(line);
    const parsed = parseLine(line, costPerBase);
    const error = isParseError(parsed) ? parsed : null;
    const sign = line.sign === -1 ? -1 : 1;
    const lineCost =
      !isParseError(parsed) && parsed.lineCost != null
        ? sign * parsed.lineCost
        : null;
    return {
      line,
      parsed,
      error,
      costPerBase,
      costSource,
      state: lineCostState(costPerBase),
      lineCost,
      hint: isParseError(parsed)
        ? null
        : unitHint(line.measureKind, parsed.qtyBase),
    };
  });
  const summary = summarizeRecipe(
    partial.map((v) => ({
      valid: v.error == null,
      costPerBase: v.costPerBase,
      lineCostCents: v.lineCost,
    })),
    priceCents,
    tax,
  );
  const views = partial.map((v) => ({
    ...v,
    share: costSharePct(v.lineCost, summary.totalCents),
  }));
  return { views, summary };
}
