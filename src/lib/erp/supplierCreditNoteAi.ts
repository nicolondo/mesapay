// «Leer con IA» de una nota crédito de proveedor — LÓGICA PURA. Reutiliza
// la lectura de facturas de compra (`extractPurchaseInvoice`, que reconoce
// `documentType: "nota_credito"`) y la traduce a los campos de la nota. El
// operador revisa todo antes de guardar: esto sólo PRELLENA.
import type { PurchaseInvoiceExtraction } from "@/lib/anthropic";
import { inferIvaPct } from "./expenseAi";
import type { SupplierCreditNoteKind } from "./supplierCreditNotes";

export type CreditNotePrefill = {
  /** ¿La IA la reconoció como nota crédito? (si no, se avisa: parece una factura). */
  isCreditNote: boolean;
  number: string | null;
  /** yyyy-mm-dd */
  date: string | null;
  cude: string | null;
  supplierName: string | null;
  supplierTaxId: string | null;
  totalCents: number | null;
  /** IVA SOLO si la nota lo discrimina. */
  ivaCents: number | null;
  ivaPct: number | null;
  incCents: number | null;
  concept: string | null;
  /** Tipo sugerido por el concepto impreso. */
  kind: SupplierCreditNoteKind | null;
  referencedInvoiceNumbers: string[];
  confidence: number;
};

const pos = (n: number | null | undefined): number | null =>
  n != null && Number.isFinite(n) && n >= 0 ? Math.round(n) : null;

/** Tipo sugerido por el texto del concepto / las líneas. */
export function guessCreditNoteKind(text: string): SupplierCreditNoteKind | null {
  const t = text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  if (!t.trim()) return null;
  if (/devoluci|devuelt|retorno de mercanc/.test(t)) return "return";
  if (/pronto pago|condicionad|pago anticipado|pago oportuno/.test(t)) return "conditional_discount";
  if (/bonificaci|acuerdo|rappel|rebate|volumen|cumplimiento|meta|convenio|plan comercial|incentivo/.test(t)) {
    return "agreement";
  }
  if (/descuento|rebaja|dcto|ajuste de precio/.test(t)) return "discount";
  return null;
}

export function creditNotePrefillFromInvoice(
  x: PurchaseInvoiceExtraction,
  country: string | null = "CO",
): CreditNotePrefill {
  const iva = pos(x.invoiceTaxCents);
  const inc = pos(x.invoiceIncCents);
  const subtotal = pos(x.invoiceSubtotalCents);
  const discount = pos(x.invoiceDiscountCents) ?? 0;
  const linesTotal = x.lines.reduce((s, l) => s + (l.lineTotalCents ?? 0), 0);
  const total =
    pos(x.invoiceTotalCents) ??
    (subtotal != null ? subtotal - discount + (iva ?? 0) + (inc ?? 0) : linesTotal > 0 ? linesTotal : null);
  const base = total != null ? total - (iva ?? 0) - (inc ?? 0) : null;
  const concept = x.creditNoteConcept ?? (x.lines.length === 1 ? x.lines[0]!.description : null);
  const kindText = [concept ?? "", ...x.lines.map((l) => l.description)].join(" ");
  return {
    isCreditNote: x.documentType === "nota_credito",
    number: x.supplierInvoiceNumber?.trim() || null,
    date: x.issueDate && /^\d{4}-\d{2}-\d{2}$/.test(x.issueDate) ? x.issueDate : null,
    cude: x.cude ?? null,
    supplierName: x.supplierName,
    supplierTaxId: x.supplierNit,
    totalCents: total != null && total > 0 ? total : null,
    ivaCents: iva && iva > 0 ? iva : null,
    ivaPct: iva && iva > 0 && base != null && base > 0 ? inferIvaPct(base, iva, country) : null,
    incCents: inc && inc > 0 ? inc : null,
    concept: concept?.trim() || null,
    kind: guessCreditNoteKind(kindText),
    referencedInvoiceNumbers: x.referencedInvoiceNumbers ?? [],
    confidence: x.confidence,
  };
}
