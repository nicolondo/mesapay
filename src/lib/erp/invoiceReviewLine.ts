import { DEFAULT_INPUT_UNIT, DISPLAY_UNITS, toBaseQty, type MeasureKind } from "./units";
import { invoiceLineAmounts, type InvoiceAmountKind, type InvoiceTaxBasis } from "./invoiceAmounts";

type SuggestedPresentation = {
  supplierItemId: string;
  presentationLabel: string;
  contentQty: number;
  lastPriceCents: number | null;
};

export type InvoiceReviewLine = {
  key: number;
  sourceLineIndex?: number;
  sourceDescription?: string;
  rememberMatch?: boolean;
  manuallySelected?: boolean;
  matchSource?: "alias" | "name";
  aliasUnavailable?: boolean;
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
  cost: string; // importe transcrito/editado en pesos; su interpretación es explícita
  amountKind: InvoiceAmountKind;
  taxBasis: InvoiceTaxBasis;
  taxBasisManual?: boolean;
  taxPct: number | null; // null exige elegir una tarifa, no significa exento
  taxAmount: string; // IVA TOTAL explícito; vacío calcula desde tarifa/base
  incAmount: string; // consumo TOTAL de la línea, nunca por unidad
  amountLabel?: string | null;
  incNeedsReview?: boolean;
  lowConfidence: boolean;
  readUnit: string | null; // unidad leída (pista)
  readQty: number; // cantidad leída (pista)
};

export function reviewPriceQuantity(line: InvoiceReviewLine): number {
  return Number((line.qtyMode === "presentation" && line.suggestedPresentation
    ? line.presentations : line.qty).replace(",", "."));
}

/** An explicit operator choice wins over detection for the rest of this review. */
export function setReviewTaxIncluded(line: InvoiceReviewLine, included: boolean): InvoiceReviewLine {
  const taxBasis = included ? "gross" : "net";
  return { ...line, taxBasis, taxBasisManual: true,
    taxAmount: line.taxBasis === "unknown" || line.taxBasis === taxBasis ? line.taxAmount : "" };
}

function typedCents(value: string): number | null {
  if (!/^\d+(?:[.,]\d{0,2})?$/.test(value.trim())) return null;
  const cents = Math.round(Number(value.replace(",", ".")) * 100);
  return Number.isSafeInteger(cents) && cents >= 0 ? cents : null;
}

/** The same interpreted amounts feed the preview and the confirmation payload. */
export function reviewLineAmounts(line: InvoiceReviewLine) {
  const amountCents = typedCents(line.cost);
  const taxCents = line.taxAmount.trim() === "" ? undefined : typedCents(line.taxAmount);
  const incCents = line.incAmount.trim() === "" ? 0 : typedCents(line.incAmount);
  if (amountCents == null || taxCents === null || incCents == null || line.taxPct == null
    || (line.incNeedsReview && line.incAmount.trim() === "")) return null;
  return invoiceLineAmounts({ amountCents, amountKind: line.amountKind,
    quantity: reviewPriceQuantity(line), taxBasis: line.taxBasis, taxPct: line.taxPct, taxCents, incCents });
}

/** Switching quantity units/presentations must not multiply a unit price again. */
export function fixReviewPriceAsTotal(line: InvoiceReviewLine): InvoiceReviewLine {
  if (line.amountKind === "line") return line;
  const amount = typedCents(line.cost);
  const quantity = reviewPriceQuantity(line);
  return { ...line, amountKind: "line", cost: amount != null && Number.isFinite(quantity) && quantity > 0
    ? String(Math.round(amount * quantity) / 100) : "" };
}

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
    ...fixReviewPriceAsTotal(line),
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
