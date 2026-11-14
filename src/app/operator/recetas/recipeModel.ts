// Modelo del editor de recetas (cliente): los DTO de GET /api/operator/
// recipes y las líneas editables (lo que se teclea → unidad base, costo en
// vivo). Sin React: lo usan la lista, el detalle del plato y el editor de
// sub-recetas, y se prueba sin DOM.

import type { Locale } from "@/i18n/config";
import { formatMoney, numberFormatter } from "@/lib/format";
import { parseDecimalInput } from "@/lib/decimalInput";
import { REFERENCE_PRICE_QTY_BASE, referencePriceUnit } from "@/lib/erp/ingredientPrice";
import { grossQty, MAX_WASTE_PCT } from "@/lib/erp/recipes";
import type { CostSource } from "@/lib/erp/recipes";
import {
  BASE_SYMBOL_FACTOR,
  BASE_UNIT_SYMBOL,
  DEFAULT_INPUT_UNIT,
  DISPLAY_UNITS,
  toBaseQty,
  type MeasureKind,
} from "@/lib/erp/units";

/* ───────────────────────────── DTO ─────────────────────────────────── */

export type { CostSource } from "@/lib/erp/recipes";

export type RecipeItemDto = {
  ingredientId: string;
  qtyBase: number;
  wastePct: number;
  ingredientName: string;
  measureKind: MeasureKind;
};

/** Delta de insumo por opción de modificador: qtyBase con SIGNO. */
export type ModifierItemDto = RecipeItemDto & {
  modifierId: string;
  optLabel: string;
};

/** Grupo de modificador del plato (para colgarle insumos por opción). */
export type ModifierGroupDto = {
  id: string;
  label: string;
  type: "radio" | "checkbox";
  opts: string[];
};

export type RecipeDto = {
  id: string;
  notes: string | null;
  items: RecipeItemDto[];
  modifierItems: ModifierItemDto[];
};

export type CostLineDto = {
  ingredientId: string;
  qtyBase: number;
  wastePct: number;
  grossQtyBase: number;
  costPerBase: number | null;
  source: CostSource;
  lineCostCents: number | null;
};

export type CostDto = {
  costCents: number;
  complete: boolean;
  lines: CostLineDto[];
};

export type DishRow = {
  menuItemId: string;
  name: string;
  category: { id: string; label: string };
  priceCents: number;
  available: boolean;
  modifiers: ModifierGroupDto[];
  recipe: RecipeDto | null;
  cost: CostDto | null;
};

export type IngredientOption = {
  id: string;
  name: string;
  measureKind: MeasureKind;
  /** Centavos por unidad base (float) o null = sin fuente de costo (D3). */
  costPerBase: number | null;
  costSource: CostSource;
};

/* ─────────────────────────── Helpers ───────────────────────────────── */

/** Búsqueda sin acentos: minúsculas + tildes fuera ("azucar" → "azúcar"). */
export function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/** "g/kg", "ml/L", "un" — símbolos de unidad, iguales en es/en/pt. */
export function unitSymbols(kind: MeasureKind): string {
  return DISPLAY_UNITS[kind].map((u) => u.symbol).join("/");
}

/** 2500 g → { qty: "2.5", unit: "kg" } — para precargar inputs de cantidad. */
export function baseToInputQty(
  base: number,
  kind: MeasureKind,
): { qty: string; unit: string } {
  const units = DISPLAY_UNITS[kind];
  const big = units[units.length - 1];
  if (big.factor > 1 && base >= big.factor) {
    return { qty: String(base / big.factor), unit: big.symbol };
  }
  // units[0].factor: 1 para g/ml, 1000 para count "un" (base milesimal).
  return { qty: String(base / units[0].factor), unit: units[0].symbol };
}

/** "32.5%" con la convención de números de `@/lib/format`. */
export function formatPct(pct: number, locale: string): string {
  return `${numberFormatter(locale, { maximumFractionDigits: 1 }).format(pct)}%`;
}

/**
 * "$16/g" — costo por unidad base (mismo formato que el picker de insumos
 * de las sub-recetas).
 */
export function formatPerBase(
  costPerBase: number,
  kind: MeasureKind,
  currency: string,
  locale: Locale,
): string {
  // costPerBase es por unidad BASE (por milésima en count); se rotula por el
  // símbolo base ("/un"), así que se escala por BASE_SYMBOL_FACTOR.
  return `${formatMoney(Math.round(costPerBase * BASE_SYMBOL_FACTOR[kind]), { currency, locale })}/${BASE_UNIT_SYMBOL[kind]}`;
}

/**
 * "$16.000/kg" — costo por kg, L o unidad: la misma unidad en que se escribe
 * el precio de referencia, y legible para insumos baratos (la sal a $0/g).
 */
export function formatUnitCost(
  costPerBase: number,
  kind: MeasureKind,
  currency: string,
  locale: Locale,
): string {
  return `${formatMoney(Math.round(costPerBase * REFERENCE_PRICE_QTY_BASE), { currency, locale })}/${referencePriceUnit(kind)}`;
}

/**
 * Orden de las coincidencias del buscador de insumos: primero los que
 * empiezan con lo escrito, después los que tienen una palabra que empieza
 * así y al final el resto (todo sin tildes), hasta `limit`. Sin texto, el
 * catálogo entero en su orden (alfabético desde el server).
 */
export function rankIngredients(
  options: readonly IngredientOption[],
  query: string,
  limit = 60,
): IngredientOption[] {
  const needle = fold(query.trim());
  // Sin texto se puede recorrer el catálogo entero (ya viene en orden).
  if (!needle) return [...options];
  const scored: { o: IngredientOption; score: number; i: number }[] = [];
  options.forEach((o, i) => {
    const hay = fold(o.name);
    const at = hay.indexOf(needle);
    if (at < 0) return;
    const score = at === 0 ? 0 : /\s/.test(hay[at - 1] ?? "") ? 1 : 2;
    scored.push({ o, score, i });
  });
  scored.sort((a, b) => a.score - b.score || a.i - b.i);
  return scored.slice(0, limit).map((s) => s.o);
}

/* ─────────────────────── Líneas editables ──────────────────────────── */

export type EditLine = {
  key: number;
  ingredientId: string;
  ingredientName: string;
  measureKind: MeasureKind;
  /** Snapshot de la cascada D3 para el costo EN VIVO (null = sin costo). */
  costPerBase: number | null;
  costSource: CostSource;
  qtyRaw: string;
  unit: string;
  wasteRaw: string;
  /** Solo líneas de modificador: +1 agrega, −1 quita. undefined = +1 (base). */
  sign?: 1 | -1;
};

/** Línea de insumo atada a una opción de modificador. */
export type ModLine = EditLine & { modifierId: string; optLabel: string };

export type ParseError = "qty_invalid" | "qty_too_small" | "waste_invalid";

export type ParsedLine =
  | {
      qtyBase: number;
      wastePct: number;
      grossBase: number;
      lineCost: number | null;
    }
  | ParseError;

export function isParseError(p: ParsedLine): p is ParseError {
  return typeof p === "string";
}

/** Menor cantidad representable en una unidad de display (1 unidad base). */
export function minQtyLabel(
  kind: MeasureKind,
  unitSymbol: string,
  locale: string = "es",
): string {
  const unit = DISPLAY_UNITS[kind].find((u) => u.symbol === unitSymbol);
  if (!unit) return "";
  const decimals = String(unit.factor).length - 1;
  const min = numberFormatter(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(1 / unit.factor);
  return `${min} ${unit.symbol}`;
}

/**
 * Parseo + costo en vivo de una línea: bruto = neto / (1 − merma%).
 * `costPerBase` permite costear con un costo más nuevo que el snapshot
 * de la línea (p. ej. recién corregido); por defecto, el de la línea.
 */
export function parseLine(
  l: EditLine,
  costPerBase: number | null = l.costPerBase,
): ParsedLine {
  const value = parseDecimalInput(l.qtyRaw);
  const qtyBase = toBaseQty(value, l.measureKind, l.unit);
  if (qtyBase == null) {
    // Un número positivo que no llega a 1 unidad base no es un error de
    // tipeo: es que la unidad elegida no tiene esa resolución (0,05 ml).
    // Se distingue para poder decir cuál es el mínimo y no un genérico.
    return isFinite(value) && value > 0 ? "qty_too_small" : "qty_invalid";
  }
  const wRaw = l.wasteRaw.trim();
  const wastePct = wRaw === "" ? 0 : Number(wRaw);
  if (!Number.isInteger(wastePct) || wastePct < 0 || wastePct > MAX_WASTE_PCT) {
    return "waste_invalid";
  }
  const gross = grossQty(qtyBase, wastePct);
  const lineCost = costPerBase != null ? Math.round(gross * costPerBase) : null;
  return { qtyBase, wastePct, grossBase: Math.round(gross), lineCost };
}

let lineKeySeq = 0;

/** Línea nueva desde el picker de insumos (unidad predeterminada, sin merma). */
export function newEditLine(ing: IngredientOption): EditLine {
  return {
    key: ++lineKeySeq,
    ingredientId: ing.id,
    ingredientName: ing.name,
    measureKind: ing.measureKind,
    costPerBase: ing.costPerBase,
    costSource: ing.costSource,
    qtyRaw: "",
    unit: DEFAULT_INPUT_UNIT[ing.measureKind],
    wasteRaw: "0",
  };
}

/** Línea precargada desde una receta guardada (rescatando el costo D3). */
export function editLineFromItem(
  it: RecipeItemDto,
  ingById: Map<string, IngredientOption>,
  costLines: CostLineDto[] | undefined,
): EditLine {
  const { qty, unit } = baseToInputQty(it.qtyBase, it.measureKind);
  // El costo sale del catálogo de insumos activos; para insumos que salieron
  // del catálogo (archivados) se rescata el de las líneas de costo.
  const fromCatalog = ingById.get(it.ingredientId);
  const fromCost = costLines?.find((l) => l.ingredientId === it.ingredientId);
  return {
    key: ++lineKeySeq,
    ingredientId: it.ingredientId,
    ingredientName: it.ingredientName,
    measureKind: it.measureKind,
    costPerBase: fromCatalog
      ? fromCatalog.costPerBase
      : (fromCost?.costPerBase ?? null),
    costSource: fromCatalog ? fromCatalog.costSource : (fromCost?.source ?? null),
    qtyRaw: qty,
    unit,
    wasteRaw: String(it.wastePct),
  };
}

/**
 * Suma EN VIVO de las líneas del editor (se recalcula al teclear, antes de
 * guardar): total de las líneas costeables; incompleto si alguna línea no
 * tiene fuente de costo o aún no parsea.
 */
export function liveLinesTotal(lines: EditLine[]): {
  total: number;
  complete: boolean;
} {
  let total = 0;
  let incomplete = false;
  for (const l of lines) {
    const p = parseLine(l);
    if (isParseError(p) || p.lineCost == null) {
      incomplete = true;
      continue;
    }
    total += p.lineCost;
  }
  return { total, complete: lines.length > 0 && !incomplete };
}

/** Línea lista para el PUT, o el primer error con la línea culpable. */
export type LinesPayload<T> =
  | { ok: true; items: T[] }
  | { ok: false; error: ParseError; line: EditLine };

/** Valida todas las líneas en orden y arma el payload del PUT. */
export function buildLinesPayload<L extends EditLine, T>(
  lines: L[],
  toItem: (l: L, p: { qtyBase: number; wastePct: number }) => T,
): LinesPayload<T> {
  const items: T[] = [];
  for (const l of lines) {
    const p = parseLine(l);
    if (isParseError(p)) return { ok: false, error: p, line: l };
    items.push(toItem(l, p));
  }
  return { ok: true, items };
}

/**
 * Huella de lo editable (cantidades, unidades, mermas, signos, notas) para
 * saber si hay cambios sin guardar. El costo no cuenta: corregir el precio
 * de un insumo se guarda aparte, en el insumo.
 */
export function draftFingerprint(
  lines: EditLine[],
  modLines: ModLine[],
  notes: string,
): string {
  const norm = (l: EditLine) => {
    const p = parseLine(l);
    // Lo parseado iguala "180" y "180,0"; lo que no parsea compara el texto.
    const qty = isParseError(p) ? `raw:${l.qtyRaw.trim()}|${l.unit}|${l.wasteRaw.trim()}` : `${p.qtyBase}|${p.wastePct}`;
    return `${l.ingredientId}|${qty}|${l.sign ?? 1}`;
  };
  return JSON.stringify([
    lines.map(norm),
    modLines.map((l) => `${l.modifierId}|${l.optLabel}|${norm(l)}`),
    notes.trim(),
  ]);
}
