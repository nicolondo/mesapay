/**
 * Exportación de los AUXILIARES de impuestos a CSV y Excel (lógica pura):
 * arma secciones tipadas con el mismo dialecto del análisis de ventas
 * (`salesAnalysis/export.ts`: CSV con `;`, coma decimal, BOM y guardia
 * contra fórmulas; Excel con una hoja por sección y números de verdad).
 *
 *  · un renglón (`nodo=<id>`): una sección con sus filas;
 *  · todo (`nodo=todo`): Resumen (niveles 1 y 2), Documentos (todos los
 *    hechos documentales), Libro (todas las líneas tributarias) y Revisar
 *    (las revisiones con hallazgos y sus filas).
 *
 * Los textos llegan ya traducidos en `labels`: este módulo no sabe de i18n.
 */
import type { ExportCell, ExportSection } from "@/lib/salesAnalysis/export";
import type { AuxRow } from "./auxRows";
import type { CheckResult } from "./taxesChecks";
import type { DocFact, DrillFacts, DrillTaxKey, LedgerFact, TaxDrill } from "./taxesDrill";

export type TaxesExportLabels = {
  col: Record<
    | "date"
    | "document"
    | "reference"
    | "party"
    | "nit"
    | "rate"
    | "base"
    | "tax"
    | "voucher"
    | "source"
    | "account"
    | "accountName"
    | "memo"
    | "value"
    | "day"
    | "expected"
    | "book"
    | "difference"
    | "taxName"
    | "origin"
    | "concept"
    | "docs"
    | "count"
    | "grossTax"
    | "nonDeductible"
    | "notes",
    string
  >;
  sections: { summary: string; docs: string; ledger: string; checks: string };
  taxLabel: (tax: DrillTaxKey) => string;
  originLabel: (origin: string) => string;
  sourceLabel: (source: string) => string;
  familyLabel: (family: string) => string;
  rateLabel: (row: { pct: number | null; conceptName: string | null; rateKey?: string }) => string;
  flagLabel: (flag: string) => string;
  checkTitle: (check: CheckResult) => string;
  finalConsumer: string;
  unnumbered: string;
};

const money = (cents: number | null | undefined): ExportCell => ({ kind: "money", cents: cents ?? null });
const int = (value: number | null | undefined): ExportCell => ({ kind: "int", value: value ?? null });
const text = (value: string | null | undefined): ExportCell => ({ kind: "text", value: value ?? null });
const day = (iso: string | null | undefined) => text(iso ? iso.slice(0, 10) : null);

/** Filas de auxiliar (de un renglón o de una revisión) → una sección. */
export function auxRowsSection(title: string, rows: readonly AuxRow[], labels: TaxesExportLabels): ExportSection {
  const c = labels.col;
  const flags = (r: AuxRow) => text((r.flags ?? []).map(labels.flagLabel).join(" · ") || null);
  const hasDay = rows.some((r) => r.kind === "day");
  const hasLedger = rows.some((r) => r.kind === "ledger");
  if (hasDay) {
    return {
      key: "aux",
      title,
      headers: [c.day, c.source, c.docs, c.expected, c.book, c.difference, c.notes],
      rows: rows.map((r) => [
        day(r.dateIso),
        text(r.source ? labels.sourceLabel(r.source) : null),
        int(r.docCount),
        money(r.expectedCents),
        money(r.bookCents),
        money(r.amountCents),
        flags(r),
      ]),
    };
  }
  if (hasLedger) {
    return {
      key: "aux",
      title,
      headers: [c.date, c.voucher, c.source, c.account, c.accountName, c.party, c.nit, c.memo, c.value, c.notes],
      rows: rows.map((r) => [
        day(r.dateIso),
        text(r.voucher ?? labels.unnumbered),
        text(r.source ? labels.sourceLabel(r.source) : null),
        text(r.accountCode),
        text(r.accountName),
        text(r.party),
        text(r.nit),
        text(r.memo),
        money(r.amountCents),
        flags(r),
      ]),
    };
  }
  return {
    key: "aux",
    title,
    headers: [c.date, c.document, c.reference, c.party, c.nit, c.rate, c.base, c.value, c.voucher, c.notes],
    rows: rows.map((r) => [
      day(r.dateIso),
      text(r.document),
      text(r.reference),
      text(r.party ?? (r.docKind === "invoice" || r.docKind === "credit_note" ? labels.finalConsumer : null)),
      text(r.nit),
      text(labels.rateLabel({ pct: r.pct ?? null, conceptName: r.conceptName ?? null })),
      money(r.baseCents),
      money(r.amountCents),
      text(r.voucher ?? null),
      flags(r),
    ]),
  };
}

function docsSection(docs: readonly DocFact[], labels: TaxesExportLabels): ExportSection {
  const c = labels.col;
  return {
    key: "docs",
    title: labels.sections.docs,
    headers: [c.taxName, c.origin, c.rate, c.date, c.document, c.reference, c.party, c.nit, c.base, c.tax, c.grossTax, c.nonDeductible],
    rows: [...docs]
      .sort((a, b) => a.tax.localeCompare(b.tax) || a.origin.localeCompare(b.origin) || a.dateIso.localeCompare(b.dateIso))
      .map((f) => [
        text(labels.taxLabel(f.tax)),
        text(labels.originLabel(f.origin)),
        text(labels.rateLabel(f)),
        day(f.dateIso),
        text(f.document),
        text(f.reference),
        text(f.party ?? (f.docKind === "invoice" || f.docKind === "credit_note" ? labels.finalConsumer : null)),
        text(f.nit),
        money(f.baseCents),
        money(f.taxCents),
        money(f.grossTaxCents),
        money(f.nonDeductibleCents),
      ]),
  };
}

function ledgerSection(ledger: readonly LedgerFact[], labels: TaxesExportLabels): ExportSection {
  const c = labels.col;
  return {
    key: "ledger",
    title: labels.sections.ledger,
    headers: [c.taxName, c.date, c.voucher, c.source, c.account, c.accountName, c.party, c.nit, c.memo, c.value, c.notes],
    rows: [...ledger]
      .sort((a, b) => a.family.localeCompare(b.family) || a.dateIso.localeCompare(b.dateIso))
      .map((l) => [
        text(l.tax ? labels.taxLabel(l.tax) : labels.familyLabel(l.family)),
        day(l.dateIso),
        text(l.voucher ?? labels.unnumbered),
        text(labels.sourceLabel(l.source)),
        text(l.accountCode),
        text(l.accountName),
        text(l.party),
        text(l.nit),
        text(l.memo),
        money(l.valueCents),
        text(l.voided ? labels.flagLabel("voided") : null),
      ]),
  };
}

function summarySection(drill: TaxDrill, labels: TaxesExportLabels): ExportSection {
  const c = labels.col;
  const rows: ExportCell[][] = [];
  for (const t of drill.taxes) {
    if (t.status === "empty") continue;
    rows.push([text(labels.taxLabel(t.key)), text(null), text(null), int(null), money(t.docCents), money(t.bookCents), money(t.diffCents)]);
    for (const n of t.docNodes) {
      rows.push([text(labels.taxLabel(t.key)), text(labels.originLabel(n.origin)), text(labels.rateLabel(n)), int(n.count), money(n.taxCents), text(null), text(null)]);
    }
    for (const n of t.bookNodes) {
      rows.push([text(labels.taxLabel(t.key)), text(labels.sourceLabel(n.source)), text(null), int(n.count), text(null), money(n.valueCents), text(null)]);
    }
  }
  for (const n of drill.others.nodes) {
    rows.push([text(labels.familyLabel(n.family)), text(null), text(null), int(n.count), text(null), money(n.valueCents), text(null)]);
  }
  return {
    key: "summary",
    title: labels.sections.summary,
    headers: [c.taxName, c.origin, c.rate, c.count, c.docs, c.book, c.difference],
    rows,
  };
}

function checksSection(checks: readonly CheckResult[], labels: TaxesExportLabels): ExportSection {
  const c = labels.col;
  const rows: ExportCell[][] = [];
  for (const k of checks) {
    if (k.count === 0) continue;
    const title = labels.checkTitle(k);
    if (k.rows.length === 0) rows.push([text(title), day(null), text(null), text(null), text(null), money(k.amountCents)]);
    for (const r of k.rows) {
      rows.push([
        text(title),
        day(r.dateIso),
        text(r.kind === "ledger" ? (r.voucher ?? labels.unnumbered) : (r.document ?? null)),
        text(r.party ?? null),
        text(r.nit ?? null),
        money(r.amountCents),
      ]);
    }
  }
  return { key: "checks", title: labels.sections.checks, headers: [c.concept, c.date, c.document, c.party, c.nit, c.value], rows };
}

/** Todo el despliegue: resumen, documentos, libro y revisiones. */
export function allTaxesSections(
  drill: TaxDrill,
  facts: DrillFacts,
  checks: readonly CheckResult[],
  labels: TaxesExportLabels,
): ExportSection[] {
  return [
    summarySection(drill, labels),
    docsSection(facts.docs, labels),
    ledgerSection(facts.ledger, labels),
    checksSection(checks, labels),
  ];
}
