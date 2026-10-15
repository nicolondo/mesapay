import { DEFAULT_INPUT_UNIT, DISPLAY_UNITS, toBaseQty, type MeasureKind } from "./units";

type SuggestedPresentation = {
  supplierItemId: string;
  presentationLabel: string;
  contentQty: number;
  lastPriceCents: number | null;
};

export type InvoiceReviewLine = {
  key: number;
  // Insumo: existente (id) o nuevo (id null + nombre + measureKind).
  ingredientId: string | null;
  ingredientName: string;
  measureKind: MeasureKind;
  // Presentación sugerida (para el modo "por presentación").
  suggestedPresentation: SuggestedPresentation | null;
  qtyMode: "presentation" | "direct";
  presentations: string; // modo presentación
  qty: string; // modo directo
  unit: string; // modo directo
  cost: string; // costo NETO total de la línea, en pesos
  taxPct: number; // IVA de la línea (0–100)
  lowConfidence: boolean;
  readUnit: string | null; // unidad leída (pista)
  readQty: number; // cantidad leída (pista)
};

/** Cantidad en unidad base de una línea, o null si es inválida. */
export function reviewLineQtyBase(l: InvoiceReviewLine): number | null {
  if (l.qtyMode === "presentation" && l.suggestedPresentation) {
    const n = Number(l.presentations);
    if (!Number.isInteger(n) || n < 1) return null;
    const base = n * l.suggestedPresentation.contentQty;
    return Number.isSafeInteger(base) && base >= 1 && base <= 2_000_000_000 ? base : null;
  }
  return toBaseQty(Number(l.qty.replace(",", ".")), l.measureKind, l.unit);
}

/** A presentation belongs to its ingredient. Never reuse it after correcting a match. */
export function selectReviewIngredient(
  line: InvoiceReviewLine,
  ingredient: { id: string | null; name: string; measureKind: MeasureKind },
): InvoiceReviewLine {
  if (ingredient.id != null && ingredient.id === line.ingredientId && ingredient.measureKind === line.measureKind) {
    return { ...line, ingredientName: ingredient.name };
  }
  let qty = line.qty;
  let unit = line.unit;
  if (ingredient.measureKind !== line.measureKind) {
    // Different dimensions cannot be converted safely. Require the operator's quantity.
    qty = "";
    unit = DEFAULT_INPUT_UNIT[ingredient.measureKind];
  } else if (line.qtyMode === "presentation" && line.suggestedPresentation) {
    const base = reviewLineQtyBase(line);
    unit = DEFAULT_INPUT_UNIT[ingredient.measureKind];
    const factor = DISPLAY_UNITS[ingredient.measureKind].find(u => u.symbol === unit)!.factor;
    qty = base == null ? "" : String(base / factor);
  }
  return {
    ...line,
    ingredientId: ingredient.id,
    ingredientName: ingredient.name,
    measureKind: ingredient.measureKind,
    suggestedPresentation: null,
    qtyMode: "direct",
    presentations: "1",
    qty,
    unit,
  };
}
