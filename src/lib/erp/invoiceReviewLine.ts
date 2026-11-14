import { DEFAULT_INPUT_UNIT, DISPLAY_UNITS, toBaseQty, type MeasureKind } from "./units";
import { invoiceLineAmounts, type InvoiceAmountKind, type InvoiceTaxBasis } from "./invoiceAmounts";
import { discountAmountCents, hasDiscount, parseDiscountInput, resolveOrderDiscounts, toPersistedDiscount, type DiscountInput } from "./purchaseDiscount";
import { lineTaxCents } from "./purchaseTax";

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
  // Descuento de la línea, como en la orden de compra: texto + % o valor.
  // Se aplica sobre el importe digitado (`cost`), en su misma base.
  discRaw?: string;
  discIsPct?: boolean;
  /** Precio de lista y descuento tomados de la factura (pista). */
  discountFromInvoice?: boolean;
  /** Descuento impreso en la línea que no cuadró con su precio: no se aplicó. */
  discountUnmatched?: boolean;
  /** El IVA impreso de la línea se calculó antes del descuento; se conserva. */
  taxBeforeDiscount?: boolean;
  /** Cantidad × unitario no da el total impreso (total − cantidad × unitario). */
  arithmeticDiffCents?: number | null;
  /** Valor impreso en la columna de consumo (sin interpretar), para mostrar la cuenta. */
  incCellCents?: number | null;
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

/** Descuento digitado en la línea (vacío = sin descuento). */
export function reviewLineDiscount(line: InvoiceReviewLine): DiscountInput {
  return parseDiscountInput(line.discRaw ?? "", line.discIsPct ?? true);
}

const MAX_REVIEW_CENTS = 2_000_000_000;

/** Importe digitado de TODA la línea, antes del descuento y en su misma base. */
function reviewListAmount(line: InvoiceReviewLine, amountCents: number): number | null {
  if (line.amountKind === "line") return amountCents;
  const quantity = reviewPriceQuantity(line);
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  const total = Math.round(amountCents * quantity);
  return Number.isSafeInteger(total) && total <= MAX_REVIEW_CENTS ? total : null;
}

/**
 * The same interpreted amounts feed the preview and the confirmation payload.
 * A line discount reduces the typed amount BEFORE its tax basis is read: the
 * IVA (when not printed) is computed on the discounted base, never on the list.
 */
export function reviewLineAmounts(line: InvoiceReviewLine) {
  const amountCents = typedCents(line.cost);
  const taxCents = line.taxAmount.trim() === "" ? undefined : typedCents(line.taxAmount);
  const incCents = line.incAmount.trim() === "" ? 0 : typedCents(line.incAmount);
  if (amountCents == null || taxCents === null || incCents == null || line.taxPct == null
    || (line.incNeedsReview && line.incAmount.trim() === "")) return null;
  const discount = reviewLineDiscount(line);
  if (!hasDiscount(discount)) {
    return invoiceLineAmounts({ amountCents, amountKind: line.amountKind,
      quantity: reviewPriceQuantity(line), taxBasis: line.taxBasis, taxPct: line.taxPct, taxCents, incCents });
  }
  const list = reviewListAmount(line, amountCents);
  if (list == null) return null;
  return invoiceLineAmounts({ amountCents: list - discountAmountCents(list, discount), amountKind: "line",
    quantity: reviewPriceQuantity(line), taxBasis: line.taxBasis, taxPct: line.taxPct, taxCents, incCents });
}

export type ReviewLineDiscountDetail = {
  /** Neto de lista (sin impuestos, antes de descuentos): `listCostCents`. */
  listCents: number;
  /** Descuento de la línea en la forma que se guarda, sobre `listCents`. */
  discount: { pct: number | null; cents: number | null };
  /** Para mostrar: importe de toda la línea antes del descuento, en la base digitada. */
  shownListCents: number;
  /** Para mostrar: descuento en pesos sobre ese importe. */
  shownDiscountCents: number;
};

/**
 * Cómo se llegó al neto de la línea, en los términos que guarda #393: lista
 * neta + descuento. `resolveOrderDiscounts(listCents, discount)` reproduce
 * EXACTAMENTE `reviewLineAmounts(line).netCents` — el servidor lo verifica.
 */
export function reviewLineDiscountDetail(
  line: InvoiceReviewLine,
  amounts = reviewLineAmounts(line),
): ReviewLineDiscountDetail | null {
  const amountCents = typedCents(line.cost);
  if (amounts == null || amountCents == null) return null;
  const discount = reviewLineDiscount(line);
  const list = reviewListAmount(line, amountCents);
  if (!hasDiscount(discount) || list == null) {
    return { listCents: amounts.netCents, discount: { pct: null, cents: null }, shownListCents: list ?? amounts.totalCents, shownDiscountCents: 0 };
  }
  const off = discountAmountCents(list, discount);
  if (line.taxBasis === "net") {
    const pct = discount.pct != null && discount.pct > 0 && Number.isInteger(discount.pct) ? discount.pct : null;
    return { listCents: list, discount: pct != null ? { pct, cents: null } : { pct: null, cents: off > 0 ? off : null },
      shownListCents: list, shownDiscountCents: off };
  }
  // Importe con impuestos incluidos: el descuento se aplicó sobre ese importe.
  // Su equivalente antes de impuestos es la diferencia de las dos bases.
  const undiscounted = invoiceLineAmounts({ amountCents: list, amountKind: "line", quantity: reviewPriceQuantity(line),
    taxBasis: line.taxBasis, taxPct: line.taxPct ?? 0, taxCents: null, incCents: amounts.incCents });
  const listNet = Math.max(amounts.netCents, undiscounted?.netCents ?? amounts.netCents);
  const cents = listNet - amounts.netCents;
  return { listCents: listNet, discount: { pct: null, cents: cents > 0 ? cents : null }, shownListCents: list, shownDiscountCents: off };
}

export type ResolvedReviewLine = {
  listCents: number;
  discountPct: number | null;
  discountCents: number | null;
  lineDiscountCents: number;
  orderDiscountCents: number;
  netCents: number;
  taxCents: number;
  incCents: number;
  totalCents: number;
};

/**
 * Toda la factura en revisión: descuento de cada línea y después el del
 * total, prorrateado con `resolveOrderDiscounts` (#393) sobre lo que quedó.
 * IVA: el documental (digitado/impreso) se conserva; el automático se
 * calcula sobre la base YA descontada. Las líneas incompletas quedan en null
 * y no reciben parte del descuento del total.
 */
export function resolveReviewInvoice(lines: InvoiceReviewLine[], orderDiscount: DiscountInput) {
  const details = lines.map(line => {
    const amounts = reviewLineAmounts(line);
    const detail = reviewLineDiscountDetail(line, amounts);
    return amounts && detail ? { line, amounts, detail } : null;
  });
  const afterLineSum = details.reduce((sum, d) => sum + (d?.amounts.netCents ?? 0), 0);
  const order = toPersistedDiscount(afterLineSum, orderDiscount);
  const applied = resolveOrderDiscounts(details.map(d => d
    ? { listCents: d.detail.listCents, discount: d.detail.discount }
    : { listCents: 0, discount: {} }), order);
  const resolved: (ResolvedReviewLine | null)[] = details.map((d, i) => {
    if (!d) return null;
    const a = applied.lines[i]!;
    const explicitTax = d.line.taxAmount.trim() !== "";
    const taxCents = explicitTax || a.orderDiscountCents === 0
      ? d.amounts.taxCents : lineTaxCents(a.netCents, d.line.taxPct ?? 0);
    if (a.netCents === 0 && taxCents > 0) return null;
    return {
      listCents: a.listCents, discountPct: d.detail.discount.pct, discountCents: d.detail.discount.cents,
      lineDiscountCents: a.lineDiscountCents, orderDiscountCents: a.orderDiscountCents,
      netCents: a.netCents, taxCents, incCents: d.amounts.incCents,
      totalCents: a.netCents + taxCents + d.amounts.incCents,
    };
  });
  const sum = (pick: (line: ResolvedReviewLine) => number) =>
    resolved.reduce((total, line) => total + (line ? pick(line) : 0), 0);
  return {
    lines: resolved,
    complete: resolved.every(line => line != null),
    /** Descuento del total en la forma que se guarda. */
    orderDiscount: order,
    subtotalCents: sum(l => l.listCents),
    lineDiscountCents: sum(l => l.lineDiscountCents),
    orderDiscountCents: sum(l => l.orderDiscountCents),
    discountCents: sum(l => l.lineDiscountCents + l.orderDiscountCents),
    netCents: sum(l => l.netCents),
    taxCents: sum(l => l.taxCents),
    incCents: sum(l => l.incCents),
    totalCents: sum(l => l.totalCents),
  };
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
