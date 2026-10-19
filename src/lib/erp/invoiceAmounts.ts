/** Explicit interpretation of transcribed prices; never infer net/gross from a VAT rate. */
export type InvoiceTaxBasis = "net" | "gross" | "unknown";
export type InvoiceAmountKind = "line" | "unit";

/** OCR text is not a controlled selector: unreadable rates require review. */
export function parseInvoiceTaxPct(value: string | null | undefined): number | null {
  if (value == null || !/^\s*\d{1,3}(?:[.,]0+)?\s*%?\s*$/.test(value)) return null;
  const pct = Number(value.replace("%", "").replace(",", ".").trim());
  return Number.isInteger(pct) && pct >= 0 && pct <= 100 ? pct : null;
}

type TranscribedPrice = {
  quantity: number;
  unitPriceCents: number | null;
  lineTotalCents: number | null;
  unitPriceTaxBasis?: InvoiceTaxBasis;
  lineTotalTaxBasis?: InvoiceTaxBasis;
  unitPriceLabel?: string | null;
  lineTotalLabel?: string | null;
  lineTaxCents?: number | null;
  lineIncCents?: number | null;
  lineIncAmbiguous?: boolean;
};

/** Keep the printed amount and its own basis. An explicit line total wins. */
export function initialInvoicePrice(line: TranscribedPrice) {
  const total = line.lineTotalCents != null;
  const cents = total ? line.lineTotalCents : line.unitPriceCents;
  return {
    cost: cents == null ? "" : String(cents / 100),
    amountKind: (total ? "line" : "unit") as InvoiceAmountKind,
    taxBasis: (total ? line.lineTotalTaxBasis : line.unitPriceTaxBasis) ?? "unknown",
    taxAmount: line.lineTaxCents == null ? "" : String(line.lineTaxCents / 100),
    incAmount: line.lineIncCents == null ? "" : String(line.lineIncCents / 100),
    amountLabel: (total ? line.lineTotalLabel : line.unitPriceLabel) ?? null,
    incNeedsReview: line.lineIncAmbiguous === true || (line.lineIncCents === undefined
      && line.lineTotalTaxBasis === undefined && line.unitPriceTaxBasis === undefined),
  };
}

const MAX_CENTS = 2_000_000_000;
const validCents = (n: number) => Number.isSafeInteger(n) && n >= 0 && n <= MAX_CENTS;

/**
 * VAT and consumption are amounts for the entire line, even in unit-price mode.
 * For gross prices, VAT is the remainder after extracting the net base. Keeping
 * that amount explicitly prevents a second rounding from changing the invoice.
 */
export function invoiceLineAmounts(input: {
  amountCents: number;
  amountKind: InvoiceAmountKind;
  quantity: number;
  taxBasis: InvoiceTaxBasis;
  taxPct: number;
  taxCents?: number | null;
  incCents?: number | null;
}): { netCents: number; taxCents: number; incCents: number; totalCents: number } | null {
  const { amountCents, amountKind, quantity, taxBasis, taxPct } = input;
  const incCents = input.incCents ?? 0;
  if (taxBasis === "unknown" || !validCents(amountCents) || !validCents(incCents)
    || !Number.isFinite(quantity) || quantity <= 0
    || !Number.isInteger(taxPct) || taxPct < 0 || taxPct > 100
    || (input.taxCents != null && !validCents(input.taxCents))) return null;
  const amount = amountKind === "unit" ? Math.round(amountCents * quantity) : amountCents;
  if (!validCents(amount)) return null;
  const netCents = taxBasis === "net" ? amount
    : input.taxCents != null ? amount - incCents - input.taxCents
      : Math.round(((amount - incCents) * 100) / (100 + taxPct));
  const taxCents = input.taxCents ?? (taxBasis === "gross"
    ? amount - incCents - netCents : Math.round((netCents * taxPct) / 100));
  const totalCents = netCents + taxCents + incCents;
  if (![netCents, taxCents, totalCents].every(validCents) || (netCents === 0 && taxCents > 0)) return null;
  return { netCents, taxCents, incCents, totalCents };
}
