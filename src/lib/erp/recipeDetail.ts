// Detalle de una receta (ERP A3) — LÓGICA PURA, sin DB ni React.
//
// Las cuentas que el editor de recetas muestra mientras se escribe: costo
// por línea (bruto × costo por unidad base), participación de cada línea en
// el costo total, food cost y margen contra el precio de carta SIN el
// impuesto embebido, qué líneas no tienen costo y el aviso de unidad
// sospechosa. Es la misma aritmética que `costRecipeItems` (redondeo por
// línea), así que el total en vivo coincide con el que devuelve el server.

import { embeddedTaxCents, type SalesTaxKind } from "@/lib/erp/accounting";
import { grossQty } from "@/lib/erp/recipes";
import type { MeasureKind } from "@/lib/erp/units";

/** Impuesto de venta del comercio: los platos lo llevan EMBEBIDO en el precio. */
export type MenuTax = { kind: SalesTaxKind; pct: number };

/** Impuesto embebido en el precio de carta (0 si el comercio no cobra). */
export function menuTaxCents(priceCents: number, tax: MenuTax | null): number {
  if (!tax || tax.kind === "none") return 0;
  return embeddedTaxCents(priceCents, tax.pct);
}

/**
 * Precio de carta neto del impuesto embebido: lo que de verdad le queda al
 * comercio por plato. Un plato de $42.900 con INC 8 % deja $39.722. Es la
 * base del food cost y del margen (el impuesto no es venta del comercio).
 */
export function netMenuPriceCents(
  priceCents: number,
  tax: MenuTax | null,
): number {
  return priceCents - menuTaxCents(priceCents, tax);
}

/** Bruto redondeado a la unidad base (lo que la línea muestra como «Bruta»). */
export function grossQtyBase(qtyBase: number, wastePct: number): number {
  return Math.round(grossQty(qtyBase, wastePct));
}

/**
 * Costo de una línea en centavos: round(bruto × costo por unidad base) —
 * idéntico a `costRecipeItems`. null = el insumo no tiene fuente de costo.
 */
export function lineCostCents(
  qtyBase: number,
  wastePct: number,
  costPerBase: number | null,
): number | null {
  if (costPerBase == null || !isFinite(costPerBase)) return null;
  return Math.round(grossQty(qtyBase, wastePct) * costPerBase);
}

/** ok = tiene costo · none = sin fuente de costo · zero = resuelve a $0. */
export type LineCostState = "ok" | "none" | "zero";

export function lineCostState(costPerBase: number | null): LineCostState {
  if (costPerBase == null || !isFinite(costPerBase)) return "none";
  return costPerBase <= 0 ? "zero" : "ok";
}

/**
 * Participación (%) de una línea en el costo de la receta. Se calcula sobre
 * lo costeado: una línea sin costo no tiene participación (null), y con el
 * total en 0 nadie la tiene (no se inventa un 0 %).
 */
export function costSharePct(
  lineCost: number | null,
  totalCents: number,
): number | null {
  if (lineCost == null || totalCents <= 0) return null;
  return (lineCost / totalCents) * 100;
}

/**
 * Food cost (%) = costo de la receta / precio neto. Solo con costo COMPLETO
 * y precio neto > 0: un costo a medias daría un food cost falso.
 */
export function foodCostPct(
  costCents: number,
  netPriceCents: number,
  complete: boolean,
): number | null {
  if (!complete || netPriceCents <= 0) return null;
  return (costCents / netPriceCents) * 100;
}

/** Semáforo estándar: hasta 30 % bien · hasta 40 % atención · más, alto. */
export type FoodCostTone = "ok" | "warn" | "high";

export const FOOD_COST_OK_MAX = 30;
export const FOOD_COST_WARN_MAX = 40;

export function foodCostTone(pct: number): FoodCostTone {
  if (pct <= FOOD_COST_OK_MAX) return "ok";
  if (pct <= FOOD_COST_WARN_MAX) return "warn";
  return "high";
}

/** Una línea ya interpretada, lista para resumir. */
export type SummaryLine = {
  /** false mientras la cantidad o la merma no se pueden leer. */
  valid: boolean;
  costPerBase: number | null;
  lineCostCents: number | null;
};

export type RecipeSummary = {
  /** Suma de las líneas con costo (parcial si `complete` es false). */
  totalCents: number;
  /** Todas las líneas se leen y tienen costo (y hay al menos una). */
  complete: boolean;
  /** Líneas sin fuente de costo. */
  missingCount: number;
  /** Líneas cuyo costo resuelve a $0. */
  zeroCount: number;
  /** Líneas que todavía no se pueden leer (cantidad o merma inválida). */
  invalidCount: number;
  priceCents: number;
  taxCents: number;
  netPriceCents: number;
  /** null = no medible (costo incompleto o precio en 0). */
  foodCostPct: number | null;
  /** Precio neto − costo; null mientras el costo esté incompleto. */
  marginCents: number | null;
};

/** Resumen en vivo de la receta: costo, food cost, margen y faltantes. */
export function summarizeRecipe(
  lines: SummaryLine[],
  priceCents: number,
  tax: MenuTax | null,
): RecipeSummary {
  let totalCents = 0;
  let missingCount = 0;
  let zeroCount = 0;
  let invalidCount = 0;
  for (const l of lines) {
    const state = lineCostState(l.costPerBase);
    if (state === "none") missingCount++;
    else if (state === "zero") zeroCount++;
    if (!l.valid) {
      invalidCount++;
      continue;
    }
    if (l.lineCostCents != null) totalCents += l.lineCostCents;
  }
  const complete =
    lines.length > 0 && missingCount === 0 && invalidCount === 0;
  const taxCents = menuTaxCents(priceCents, tax);
  const netPriceCents = priceCents - taxCents;
  return {
    totalCents,
    complete,
    missingCount,
    zeroCount,
    invalidCount,
    priceCents,
    taxCents,
    netPriceCents,
    foodCostPct: foodCostPct(totalCents, netPriceCents, complete),
    marginCents: complete ? netPriceCents - totalCents : null,
  };
}

/**
 * Aviso de unidad sospechosa. «un» se cuenta por unidades enteras o
 * fracciones razonables (½ limón, un trago de 0,04 botella); por debajo de
 * una centésima de unidad casi siempre es un insumo mal dimensionado — sal
 * contada en «un» con 0,002 un por plato. Solo un aviso: nada se cambia solo.
 */
export type UnitHint = "tiny_count";

/** Menos de 0,01 un (la base de «un» es la milésima: 10 = 0,01 un). */
export const TINY_COUNT_MAX_BASE = 10;

export function unitHint(kind: MeasureKind, qtyBase: number): UnitHint | null {
  if (kind === "count" && qtyBase > 0 && qtyBase < TINY_COUNT_MAX_BASE) {
    return "tiny_count";
  }
  return null;
}
