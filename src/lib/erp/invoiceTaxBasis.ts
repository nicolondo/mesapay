import { invoiceLineAmounts, parseInvoiceTaxPct, type InvoiceTaxBasis } from "./invoiceAmounts";

/** The structural subset is also usable for previously saved OCR extractions. */
export type InvoiceTaxLine = {
  quantity: number;
  unitPriceCents: number | null;
  lineTotalCents: number | null;
  unitPriceTaxBasis?: InvoiceTaxBasis;
  lineTotalTaxBasis?: InvoiceTaxBasis;
  unitPriceLabel?: string | null;
  lineTotalLabel?: string | null;
  unitPriceTaxBasisConflict?: boolean;
  lineTotalTaxBasisConflict?: boolean;
  taxPct?: string | null;
  lineTaxCents?: number | null;
  lineIncCents?: number | null;
  lineIncAmbiguous?: boolean;
};
export type InvoiceTaxDocument = {
  lines: InvoiceTaxLine[];
  invoiceSubtotalCents?: number | null;
  invoiceDiscountCents?: number | null;
  invoiceTaxCents?: number | null;
  invoiceTotalCents?: number | null;
  invoiceIncCents?: number | null;
  retefuenteCents?: number | null;
  reteIvaCents?: number | null;
  reteIcaCents?: number | null;
};
type KnownBasis = Exclude<InvoiceTaxBasis, "unknown">;
type Evidence = { basis: InvoiceTaxBasis; conflict: boolean };
type LineEvidence = { unit: Evidence; total: Evidence };
const BASES: KnownBasis[] = ["net", "gross"];
const MAX_CENTS = 2_000_000_000;
const validCents = (value: number | null | undefined): value is number =>
  value != null && Number.isSafeInteger(value) && value >= 0 && value <= MAX_CENTS;
const near = (left: number, right: number, tolerance = 1) => Math.abs(left - right) <= tolerance;
const unknown = (): Evidence => ({ basis: "unknown", conflict: false });
const reported = (basis: InvoiceTaxBasis | undefined): Evidence => ({ basis: basis ?? "unknown", conflict: false });

function combine(...evidence: Evidence[]): Evidence {
  const bases = new Set(evidence.map(e => e.basis).filter(basis => basis !== "unknown"));
  const conflict = evidence.some(e => e.conflict) || bases.size > 1;
  return { basis: conflict || bases.size === 0 ? "unknown" : [...bases][0], conflict };
}

/** Generic “neto”, “final” and “total” do not identify a tax basis by themselves. */
function labelEvidence(label: string | null | undefined): Evidence {
  const text = (label ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
  const exclusion = /\b(?:SIN|SEM|EXCLUYENDO|EXCLUIDO|EXCLUDING|WITHOUT) (?:EL |LOS |O |OS )?(?:IVA|VAT|TAX(?:ES)?|IMPUESTOS?|IMPOSTOS?)\b|\b(?:NO INCLUYE[N]?|NAO INCLUI|NAO INCLUEM|NOT INCLUDING|DOES NOT INCLUDE) (?:EL |LOS |O |OS )?(?:IVA|VAT|IMPUESTOS?|IMPOSTOS?|TAX(?:ES)?)\b|\b(?:IVA|VAT|IMPUESTOS?|IMPOSTOS?|TAX(?:ES)?) (?:(?:NO|NAO) INCLUID[OA]S?|NOT INCLUDED)\b/g;
  const excluded = exclusion.test(text);
  const remaining = text.replace(exclusion, "");
  const net = excluded || /\bANTES (?:DE |DEL |DE LOS )?(?:IVA|IMPTO|IMPTOS|IMPUESTOS?)\b|\bBASE (?:IMPONIBLE|GRAVABLE)\b|\bBEFORE (?:TAX|VAT)\b/.test(text);
  const gross = /\b(?:CON|COM|INCLUYE|INCLUDING|WITH) (?:EL |LOS |O |OS )?(?:IVA|VAT|IMPUESTOS?|IMPOSTOS?|TAX(?:ES)?)\b|\b(?:IVA|VAT|IMPUESTOS?|IMPOSTOS?|TAX(?:ES)?) INCLUID[OA]S?\b|\b(?:IVA|VAT|TAX) INCLUDED\b/.test(remaining);
  // An unfamiliar negation must not leave its positive substring eligible.
  // E.g. “no viene con IVA” is ambiguous, never evidence for gross prices.
  const conflicting = (net && gross) || (gross && /\b(?:NO|NOT|NAO)\b/.test(remaining));
  return { basis: conflicting || net === gross ? "unknown" : net ? "net" : "gross", conflict: conflicting };
}

function validArithmetic(line: InvoiceTaxLine): boolean {
  return Number.isFinite(line.quantity) && line.quantity > 0 && !line.lineIncAmbiguous
    && (line.lineTaxCents == null || validCents(line.lineTaxCents))
    && (line.lineIncCents == null || validCents(line.lineIncCents));
}

function totalAmount(line: InvoiceTaxLine, kind: "unit" | "line"): number | null {
  const value = kind === "unit" ? line.unitPriceCents : line.lineTotalCents;
  if (!validCents(value) || !Number.isFinite(line.quantity) || line.quantity <= 0) return null;
  const total = kind === "unit" ? Math.round(value * line.quantity) : value;
  return validCents(total) ? total : null;
}

function lineAmounts(line: InvoiceTaxLine, kind: "unit" | "line", basis: KnownBasis) {
  const amount = kind === "unit" ? line.unitPriceCents : line.lineTotalCents;
  const pct = parseInvoiceTaxPct(line.taxPct);
  if (!validArithmetic(line) || !validCents(amount) || pct == null) return null;
  return invoiceLineAmounts({ amountCents: amount, amountKind: kind, quantity: line.quantity,
    taxBasis: basis, taxPct: pct, taxCents: line.lineTaxCents, incCents: line.lineIncCents });
}

/** A printed line VAT amount corroborates the rate; neither rate nor supplier is evidence alone. */
function vatEvidence(line: InvoiceTaxLine, kind: "unit" | "line"): Evidence {
  const amount = totalAmount(line, kind);
  const pct = parseInvoiceTaxPct(line.taxPct);
  const vat = line.lineTaxCents;
  if (!validArithmetic(line) || amount == null || pct == null || pct <= 0 || !validCents(vat) || vat === 0) return unknown();
  // A supplier may print IVA rounded to a whole peso. Do not use a percentage
  // tolerance: it could disguise a materially incorrect price on large invoices.
  const tolerance = vat % 100 === 0 ? 50 : 1;
  const candidates = BASES.filter(basis => {
    const amounts = lineAmounts(line, kind, basis);
    return amounts != null && near(Math.round(amounts.netCents * pct / 100), vat, tolerance);
  });
  return { basis: candidates.length === 1 ? candidates[0] : "unknown", conflict: candidates.length === 0 };
}

function localEvidence(line: InvoiceTaxLine, numericAllowed: boolean): LineEvidence {
  const forAmount = (kind: "unit" | "line"): Evidence => {
    const unit = kind === "unit";
    const amount = unit ? line.unitPriceCents : line.lineTotalCents;
    if (!validCents(amount)) return unknown();
    return combine(
      reported(unit ? line.unitPriceTaxBasis : line.lineTotalTaxBasis),
      labelEvidence(unit ? line.unitPriceLabel : line.lineTotalLabel),
      { basis: "unknown", conflict: (unit ? line.unitPriceTaxBasisConflict : line.lineTotalTaxBasisConflict) === true },
      numericAllowed ? vatEvidence(line, kind) : unknown(),
    );
  };
  return { unit: forAmount("unit"), total: forAmount("line") };
}

/** Unit and final columns can differ; only a reconciling pair can transfer evidence. */
function reconcileColumns(line: InvoiceTaxLine, evidence: LineEvidence, numericAllowed: boolean): LineEvidence {
  if (!numericAllowed || !validArithmetic(line) || evidence.unit.conflict || evidence.total.conflict
    || totalAmount(line, "unit") == null || totalAmount(line, "line") == null) return evidence;
  const candidates = BASES.flatMap(unit => BASES.map(total => ({ unit, total }))).filter(pair => {
    if ((evidence.unit.basis !== "unknown" && evidence.unit.basis !== pair.unit)
      || (evidence.total.basis !== "unknown" && evidence.total.basis !== pair.total)) return false;
    const unit = lineAmounts(line, "unit", pair.unit);
    const total = lineAmounts(line, "line", pair.total);
    return unit != null && total != null && near(unit.netCents, total.netCents)
      && near(unit.taxCents, total.taxCents) && near(unit.totalCents, total.totalCents);
  });
  if (!candidates.length) return evidence; // Unit columns may precede an undisclosed discount.
  const unique = (kind: "unit" | "total") => {
    const bases = new Set(candidates.map(pair => pair[kind]));
    return bases.size === 1 ? reported([...bases][0]) : unknown();
  };
  return { unit: combine(evidence.unit, unique("unit")), total: combine(evidence.total, unique("total")) };
}

function consumptionReconciles(invoice: InvoiceTaxDocument): boolean {
  if (invoice.invoiceIncCents == null) return true;
  if (!validCents(invoice.invoiceIncCents)) return false;
  const total = invoice.lines.reduce((sum, line) => sum + (line.lineIncCents ?? 0), 0);
  return Number.isSafeInteger(total) && near(total, invoice.invoiceIncCents);
}

/** Only a single uniform convention is inferred from the footer, never a combinatorial mix. */
function documentEvidence(invoice: InvoiceTaxDocument, numericAllowed: boolean): Evidence {
  const money = [invoice.invoiceSubtotalCents, invoice.invoiceDiscountCents, invoice.invoiceTaxCents,
    invoice.invoiceTotalCents, invoice.invoiceIncCents, invoice.retefuenteCents, invoice.reteIvaCents, invoice.reteIcaCents];
  const printed = [invoice.invoiceSubtotalCents, invoice.invoiceTaxCents, invoice.invoiceTotalCents];
  if (!numericAllowed || !invoice.lines.length || printed.filter(value => value != null).length < 2
    || money.some(value => value != null && !validCents(value))) return unknown();
  const retentions = (invoice.retefuenteCents ?? 0) + (invoice.reteIvaCents ?? 0) + (invoice.reteIcaCents ?? 0);
  const candidates = BASES.filter(basis => {
    const amounts = invoice.lines.map(line => lineAmounts(line, line.lineTotalCents != null ? "line" : "unit", basis));
    if (amounts.some(amount => amount == null)) return false;
    const sum = amounts.reduce((total, amount) => ({
      net: total.net + amount!.netCents, vat: total.vat + amount!.taxCents, gross: total.gross + amount!.totalCents,
    }), { net: 0, vat: 0, gross: 0 });
    const subtotal = invoice.invoiceSubtotalCents;
    if (subtotal != null && !near(sum.net, subtotal) && !near(sum.net, subtotal - (invoice.invoiceDiscountCents ?? 0))) return false;
    if (invoice.invoiceTaxCents != null && !near(sum.vat, invoice.invoiceTaxCents)) return false;
    return invoice.invoiceTotalCents == null || near(sum.gross - retentions, invoice.invoiceTotalCents);
  });
  return candidates.length === 1 ? reported(candidates[0]) : unknown();
}

/** A footer cannot decide the basis of a line whose two amounts are identical. */
function footerForLine(line: InvoiceTaxLine, footer: Evidence): Evidence {
  const kind = line.lineTotalCents != null ? "line" : "unit";
  const net = lineAmounts(line, kind, "net");
  const gross = lineAmounts(line, kind, "gross");
  return net != null && gross != null && net.netCents === gross.netCents
    && net.taxCents === gross.taxCents && net.totalCents === gross.totalCents ? unknown() : footer;
}

/**
 * Resolve initial review defaults only. Amounts, quantities, rates and printed
 * taxes remain immutable. Call on OCR/load, never after the user's manual edit.
 * Persist conflicts so loading an already-normalized extraction cannot erase
 * the original contradiction and silently turn an unknown basis into a guess.
 */
export function inferPurchaseInvoiceTaxBases<T extends InvoiceTaxDocument>(invoice: T): T {
  // Old uploads predate consumption extraction. Adding basis fields must not
  // erase initialInvoicePrice's mandatory review of that missing information.
  const normalized = { ...invoice, lines: invoice.lines.map(line =>
    line.lineIncCents === undefined && line.unitPriceTaxBasis === undefined && line.lineTotalTaxBasis === undefined
      ? { ...line, lineIncAmbiguous: true } : line) };
  const numericAllowed = consumptionReconciles(normalized);
  const footer = documentEvidence(normalized, numericAllowed);
  const lines = normalized.lines.map(line => {
    const local = reconcileColumns(line, localEvidence(line, numericAllowed), numericAllowed);
    const primary = line.lineTotalCents != null ? "total" : "unit";
    const combined = { ...local, [primary]: combine(local[primary], footerForLine(line, footer)) };
    const evidence = reconcileColumns(line, combined, numericAllowed);
    return { ...line, unitPriceTaxBasis: evidence.unit.basis, lineTotalTaxBasis: evidence.total.basis,
      ...(evidence.unit.conflict ? { unitPriceTaxBasisConflict: true } : {}),
      ...(evidence.total.conflict ? { lineTotalTaxBasisConflict: true } : {}),
    };
  });
  return { ...invoice, lines };
}
