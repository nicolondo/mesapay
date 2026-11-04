/**
 * Fila de AUXILIAR lista para pintar (lógica pura, sin DB ni React): la
 * forma común con la que la API de auxiliares, las revisiones y el panel
 * reutilizable (`_components/AuxiliariesPanel.tsx`) hablan de «lo que
 * formó una cifra». Tres clases:
 *
 *   · doc     un documento fuente (factura, nota crédito, compra, gasto,
 *             pedido): fecha, número con enlace, tercero, base, tarifa,
 *             valor y el asiento que lo contabilizó;
 *   · ledger  una línea del libro: fecha, comprobante con enlace, origen,
 *             cuenta, tercero y movimiento;
 *   · day     un día de un asiento del motor: lo esperado por los
 *             documentos frente a lo asentado.
 *
 * Pensado para que el estado de resultado y el balance adopten el mismo
 * despliegue: cualquier cifra del libro se explica con filas `ledger`.
 */
import { expenseHref } from "../expenseTax";
import type { DocFact, DocKind, DrillTaxKey, LedgerFact } from "./taxesDrill";
import type { ReconDayRow } from "./taxesReconcile";

/** API de los auxiliares de «Impuestos del período». */
export const TAXES_AUX_ENDPOINT = "/api/operator/reports/taxes-aux";

export type AuxRowKind = "doc" | "ledger" | "day";

/** Marcas cortas que la vista traduce (`opReportDrill.flag_<flag>`). */
export type AuxFlag =
  | "voided"
  | "estimated"
  | "dianRejected"
  | "dianPending"
  | "orderCancelled"
  | "otherPeriod"
  | "intoPeriod"
  | "noEntry"
  | "noNit"
  | "invalidDv";

export type AuxRow = {
  key: string;
  kind: AuxRowKind;
  /** ISO (doc/ledger) o día `yyyy-mm-dd` (day); null sin fecha propia. */
  dateIso: string | null;
  /** Cifra de la fila en su contexto (impuesto, movimiento o diferencia), con signo. */
  amountCents: number;
  // ── doc ──
  docKind?: DocKind;
  docId?: string | null;
  document?: string | null;
  reference?: string | null;
  party?: string | null;
  nit?: string | null;
  baseCents?: number | null;
  pct?: number | null;
  /** Clave de la tarifa (`e…` = efectiva, sin concepto que calce). */
  rateKey?: string | null;
  conceptName?: string | null;
  /** Día de negocio en que el motor lo asienta. */
  day?: string | null;
  grossTaxCents?: number | null;
  nonDeductibleCents?: number | null;
  // ── ledger / doc ──
  entryId?: string | null;
  voucher?: string | null;
  source?: string | null;
  accountCode?: string | null;
  accountName?: string | null;
  memo?: string | null;
  // ── day ──
  /** Impuesto de la fila (los días se cruzan por impuesto y fuente). */
  tax?: DrillTaxKey | null;
  expectedCents?: number;
  bookCents?: number;
  docCount?: number;
  flags?: AuxFlag[];
};

export function docAuxRow(
  f: DocFact,
  opts: { amountCents?: number; entryId?: string | null; day?: string | null; flags?: AuxFlag[] } = {},
): AuxRow {
  return {
    key: f.key,
    kind: "doc",
    dateIso: f.dateIso,
    amountCents: opts.amountCents ?? f.taxCents,
    docKind: f.docKind,
    docId: f.docId,
    document: f.document,
    reference: f.reference,
    party: f.party,
    nit: f.nit,
    baseCents: f.baseCents,
    pct: f.pct,
    rateKey: f.rateKey,
    conceptName: f.conceptName,
    day: opts.day ?? null,
    grossTaxCents: f.grossTaxCents,
    nonDeductibleCents: f.nonDeductibleCents,
    entryId: opts.entryId ?? null,
    ...(opts.flags?.length ? { flags: opts.flags } : {}),
  };
}

export function ledgerAuxRow(l: LedgerFact): AuxRow {
  return {
    key: l.key,
    kind: "ledger",
    dateIso: l.dateIso,
    amountCents: l.valueCents,
    entryId: l.entryId,
    voucher: l.voucher,
    source: l.source,
    accountCode: l.accountCode,
    accountName: l.accountName,
    party: l.party,
    nit: l.nit,
    memo: l.memo,
    ...(l.voided ? { flags: ["voided" as const] } : {}),
  };
}

export function dayAuxRow(d: ReconDayRow): AuxRow {
  return {
    key: d.key,
    kind: "day",
    dateIso: d.day,
    amountCents: d.deltaCents,
    source: d.source,
    tax: d.tax,
    entryId: d.entryId,
    expectedCents: d.expectedCents,
    bookCents: d.bookCents,
    docCount: d.docCount,
    ...(d.entryId ? {} : { flags: ["noEntry" as const] }),
  };
}

/** Σ de las filas (lo que el panel compara con la cifra del renglón padre). */
export function auxTotals(rows: readonly AuxRow[]): { count: number; amountCents: number; baseCents: number } {
  let amountCents = 0;
  let baseCents = 0;
  for (const r of rows) {
    amountCents += r.amountCents;
    baseCents += r.baseCents ?? 0;
  }
  return { count: rows.length, amountCents, baseCents };
}

/**
 * Enlace al documento fuente. Las rutas son las de la operación: la
 * factura (`/factura/[id]`), el pedido, la lista de notas crédito, la
 * compra (Compras abre su detalle con `?oc=`) y el gasto (Contabilidad ›
 * Gastos abierto en ese gasto, en el mes de su fecha contable `dateIso`).
 */
export function docHref(
  kind: DocKind | undefined,
  id: string | null | undefined,
  dateIso?: string | null,
): string | null {
  if (!kind || !id) return null;
  switch (kind) {
    case "invoice":
      return `/factura/${encodeURIComponent(id)}`;
    case "order":
      return `/operator/orders/${encodeURIComponent(id)}`;
    case "credit_note":
      return "/operator/facturas/notas-credito";
    case "purchase":
      return `/operator/compras?oc=${encodeURIComponent(id)}`;
    case "expense":
      return dateIso
        ? expenseHref(id, dateIso)
        : `/operator/contabilidad?tab=expenses&expense=${encodeURIComponent(id)}`;
    case "refund":
      return null;
  }
}

/** Enlace al comprobante contable (sirve para los del motor y los manuales). */
export function entryHref(entryId: string | null | undefined): string | null {
  return entryId ? `/operator/contabilidad/comprobantes/${encodeURIComponent(entryId)}` : null;
}
