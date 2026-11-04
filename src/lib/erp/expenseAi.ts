// «Leer con IA» del soporte de un gasto — LÓGICA PURA. Reutiliza TAL CUAL
// el extractor de facturas de compra (`extractPurchaseInvoice`, sólo
// lectura: no se toca su prompt) y traduce su resultado a los campos del
// gasto. El operador revisa todo antes de guardar: esto sólo PRELLENA.
import type { PurchaseInvoiceExtraction } from "@/lib/anthropic";
import type { ExpenseDocumentType } from "./expenseTax";
import { purchaseTaxRates, totalsMatch } from "./purchaseTax";

export type ExpensePrefill = {
  documentType: ExpenseDocumentType | null;
  documentNumber: string | null;
  /** YYYY-MM-DD */
  documentDate: string | null;
  supplierName: string | null;
  supplierTaxId: string | null;
  /** Valor ANTES de descuento e impuestos. */
  subtotalCents: number | null;
  discountCents: number | null;
  /** Tarifa deducida del IVA impreso y la base (0/5/19), si calza. */
  ivaPct: number | null;
  /** IVA impreso. */
  ivaCents: number | null;
  incCents: number | null;
  /** Total impreso, para que el operador lo compare con el calculado. */
  totalCents: number | null;
  confidence: number;
};

const pos = (n: number | null | undefined): number | null =>
  n != null && Number.isFinite(n) && n >= 0 ? Math.round(n) : null;

/** Tarifa del país que mejor explica IVA / base (±0,6 puntos), o null. */
export function inferIvaPct(baseCents: number, ivaCents: number, country: string | null = "CO"): number | null {
  if (ivaCents === 0) return 0;
  if (baseCents <= 0 || ivaCents < 0) return null;
  const pct = (ivaCents * 100) / baseCents;
  const rates = purchaseTaxRates(country).filter((r) => r > 0);
  const best = rates.reduce((a, b) => (Math.abs(b - pct) < Math.abs(a - pct) ? b : a), rates[0]!);
  return Math.abs(best - pct) <= 0.6 ? best : null;
}

/**
 * De la extracción de la IA a los campos del gasto. Decisiones:
 *  · factura → factura electrónica; cuenta de cobro → cuenta de cobro; lo
 *    demás no se adivina (el operador elige);
 *  · subtotal impreso; si no hay, total − IVA − INC;
 *  · el descuento se conserva sólo si el subtotal impreso es ANTES del
 *    descuento (subtotal − descuento + IVA + INC ≈ total). Si el subtotal
 *    ya venía neto, el descuento se descarta para no restarlo dos veces;
 *  · las retenciones impresas NO se copian: las practica el comercio con
 *    sus conceptos (las sugiere el formulario).
 */
export function expensePrefillFromInvoice(
  x: PurchaseInvoiceExtraction,
  country: string | null = "CO",
): ExpensePrefill {
  const iva = pos(x.invoiceTaxCents);
  const inc = pos(x.invoiceIncCents);
  const total = pos(x.invoiceTotalCents);
  let subtotal = pos(x.invoiceSubtotalCents);
  let discount = pos(x.invoiceDiscountCents ?? null);
  if (subtotal == null && total != null) {
    const derived = total - (iva ?? 0) - (inc ?? 0);
    subtotal = derived > 0 ? derived : null;
    discount = null;
  }
  if (subtotal != null && discount != null && discount > 0 && total != null) {
    const grossFirst = subtotal - discount + (iva ?? 0) + (inc ?? 0);
    const netAlready = subtotal + (iva ?? 0) + (inc ?? 0);
    if (!totalsMatch(grossFirst, total) && totalsMatch(netAlready, total)) discount = null;
  }
  if (discount === 0) discount = null;
  const base = subtotal != null ? subtotal - (discount ?? 0) : null;
  const documentType: ExpenseDocumentType | null =
    x.documentType === "factura" ? "e_invoice" : x.documentType === "cuenta_de_cobro" ? "charge_account" : null;
  const issue = x.issueDate && /^\d{4}-\d{2}-\d{2}$/.test(x.issueDate) ? x.issueDate : null;
  return {
    documentType,
    documentNumber: x.supplierInvoiceNumber?.trim() || null,
    documentDate: issue,
    supplierName: x.supplierName?.trim() || null,
    supplierTaxId: x.supplierNit?.trim() || null,
    subtotalCents: subtotal,
    discountCents: discount,
    ivaPct: base != null && iva != null ? inferIvaPct(base, iva, country) : null,
    ivaCents: iva,
    incCents: inc,
    totalCents: total,
    confidence: x.confidence,
  };
}
