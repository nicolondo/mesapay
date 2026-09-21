/**
 * IMPUESTOS DETALLADOS — todos los impuestos del período POR DOCUMENTO Y
 * TERCERO (lógica pura). Portado de zenith
 * `reportes/impuestos-detallados/page.tsx` (estructura del informe
 * homónimo de Siigo / World Office):
 *
 *  · IVA / INC generado (ventas): una fila por factura con impuesto, con la
 *    tarifa que la factura congeló y el adquiriente si es nominativa.
 *  · IVA descontable (compras): una fila por compra recibida y tarifa.
 *  · Retenciones practicadas y a favor: desde los ASIENTOS contra las
 *    cuentas de retención (2365/2367/2368 practicadas; 135515/17/18 a
 *    favor; más las cuentas de los conceptos de retención del comercio).
 *    El asiento manda: incluye también los comprobantes manuales sobre
 *    esas cuentas. Clasificación por naturaleza: pasivo → practicada
 *    (crédito − débito); resto → a favor (débito − crédito).
 */
import { formatVoucherNumber, isAnnulled } from "./generalLedger";
import {
  purchaseLineTaxCents,
  type PurchaseTaxInput,
  type SaleTaxInput,
} from "./taxesDocuments";
import {
  classifyTaxAccount,
  RETENTION_FAMILIES,
  type FamilyKey,
  type TaxAccount,
  type TaxLedgerLine,
} from "./taxesModel";

export type TaxDocRow = {
  key: string;
  dateIso: string;
  document: string;
  /** null = consumidor final / sin NIT. */
  nit: string | null;
  /** null = consumidor final (la vista pone la etiqueta traducida). */
  party: string | null;
  kind: "iva" | "inc";
  pct: number;
  baseCents: number;
  valorCents: number;
};

/** Línea del libro con los datos del comprobante que el detalle muestra. */
export type RetentionLedgerLine = TaxLedgerLine & {
  id: string;
  entryId: string;
  /** ISO completo del asiento (la vista lo formatea en UTC). */
  dateIso: string;
  voucherNumber: number | null;
  source: string;
  status?: string | null;
  memo?: string | null;
  thirdPartyName?: string | null;
  thirdPartyTaxId?: string | null;
};

export type RetentionRow = {
  key: string;
  dateIso: string;
  /** `#000123`; null = sin numerar (mes abierto). */
  voucher: string | null;
  source: string;
  nit: string | null;
  party: string | null;
  accountCode: string;
  accountName: string;
  /** Nombre del concepto de retención que apunta a la cuenta, si hay. */
  conceptName: string | null;
  family: FamilyKey;
  valorCents: number;
  /** Asiento anulado por reversa: suma igual (la reversa lo netea), se rotula. */
  voided: boolean;
};

export type RetentionDetail = {
  practicadas: RetentionRow[];
  aFavor: RetentionRow[];
};

export type TaxesDetail = {
  sales: TaxDocRow[];
  purchases: TaxDocRow[];
  practicadas: RetentionRow[];
  aFavor: RetentionRow[];
  stats: {
    ivaGeneradoCents: number;
    incGeneradoCents: number;
    ivaDescontableCents: number;
    retencionesPracticadasCents: number;
    retencionesAFavorCents: number;
  };
};

const byDateThenDoc = (a: { dateIso: string; document: string }, b: { dateIso: string; document: string }) =>
  a.dateIso.localeCompare(b.dateIso) || a.document.localeCompare(b.document);

/** Facturas con impuesto: una fila por documento (tarifa congelada). */
export function salesDetailRows(sales: readonly SaleTaxInput[]): TaxDocRow[] {
  const rows: TaxDocRow[] = [];
  for (const s of sales) {
    if (s.taxKind === "none" || s.taxCents === 0) continue;
    rows.push({
      key: s.invoiceId,
      dateIso: s.dateIso,
      document: s.document,
      nit: s.customer?.docNumber ?? null,
      party: s.customer?.name ?? null,
      kind: s.taxKind,
      pct: s.taxPct,
      baseCents: s.baseCents,
      valorCents: s.taxCents,
    });
  }
  return rows.sort(byDateThenDoc);
}

/** Compras con IVA: una fila por documento y tarifa. */
export function purchaseDetailRows(purchases: readonly PurchaseTaxInput[]): TaxDocRow[] {
  const rows = new Map<string, TaxDocRow>();
  for (const p of purchases) {
    for (const l of p.lines) {
      const tax = purchaseLineTaxCents(l.netCents, l.taxPct);
      if (tax === 0) continue;
      const key = `${p.purchaseId}:${l.taxPct}`;
      const prev = rows.get(key);
      if (prev) {
        prev.baseCents += l.netCents;
        prev.valorCents += tax;
      } else {
        rows.set(key, {
          key,
          dateIso: p.dateIso,
          document: p.document,
          nit: p.supplierTaxId,
          party: p.supplierName,
          kind: "iva",
          pct: l.taxPct,
          baseCents: l.netCents,
          valorCents: tax,
        });
      }
    }
  }
  return [...rows.values()].sort(byDateThenDoc);
}

const sortRet = (a: RetentionRow, b: RetentionRow) =>
  a.dateIso.localeCompare(b.dateIso) || (a.voucher ?? "").localeCompare(b.voucher ?? "") || a.key.localeCompare(b.key);

/**
 * Retenciones comprobante por comprobante, desde el libro. Solo entran las
 * líneas de cuentas que clasifican en una familia de RETENCIÓN; el resto
 * de líneas (IVA, INC…) se ignora aunque venga en la misma consulta.
 */
export function retentionDetailRows(
  lines: readonly RetentionLedgerLine[],
  accounts: readonly TaxAccount[],
  opts: { conceptsByCode?: ReadonlyMap<string, { kind: string; name: string }> } = {},
): RetentionDetail {
  const byCode = new Map<string, TaxAccount>();
  for (const a of accounts) byCode.set(a.code, a);
  const practicadas: RetentionRow[] = [];
  const aFavor: RetentionRow[] = [];
  for (const l of lines) {
    const account = byCode.get(l.accountCode) ?? {
      code: l.accountCode,
      name: "",
      type: l.accountCode.startsWith("2") ? "pasivo" : "activo",
    };
    const concept = opts.conceptsByCode?.get(l.accountCode) ?? null;
    const family = classifyTaxAccount(l.accountCode, account.type, concept?.kind);
    if (!RETENTION_FAMILIES.includes(family)) continue;
    const favor = family.endsWith("-favor");
    const valorCents = favor
      ? l.debitCents - l.creditCents
      : l.creditCents - l.debitCents;
    if (valorCents === 0) continue;
    const row: RetentionRow = {
      key: l.id,
      dateIso: l.dateIso,
      voucher: formatVoucherNumber(l.voucherNumber),
      source: l.source,
      nit: l.thirdPartyTaxId ?? null,
      party: l.thirdPartyName ?? null,
      accountCode: l.accountCode,
      accountName: account.name,
      conceptName: concept?.name ?? null,
      family,
      valorCents,
      voided: isAnnulled(l.status),
    };
    (favor ? aFavor : practicadas).push(row);
  }
  practicadas.sort(sortRet);
  aFavor.sort(sortRet);
  return { practicadas, aFavor };
}

const sum = (rows: readonly { valorCents: number }[]) =>
  rows.reduce((s, r) => s + r.valorCents, 0);

/** Arma el reporte completo a partir de sus tres fuentes. */
export function buildTaxesDetail({
  sales,
  purchases,
  ledgerLines,
  accounts,
  conceptsByCode,
}: {
  sales: readonly SaleTaxInput[];
  purchases: readonly PurchaseTaxInput[];
  ledgerLines: readonly RetentionLedgerLine[];
  accounts: readonly TaxAccount[];
  conceptsByCode?: ReadonlyMap<string, { kind: string; name: string }>;
}): TaxesDetail {
  const salesRows = salesDetailRows(sales);
  const purchaseRows = purchaseDetailRows(purchases);
  const { practicadas, aFavor } = retentionDetailRows(ledgerLines, accounts, { conceptsByCode });
  return {
    sales: salesRows,
    purchases: purchaseRows,
    practicadas,
    aFavor,
    stats: {
      ivaGeneradoCents: sum(salesRows.filter((r) => r.kind === "iva")),
      incGeneradoCents: sum(salesRows.filter((r) => r.kind === "inc")),
      ivaDescontableCents: sum(purchaseRows),
      retencionesPracticadasCents: sum(practicadas),
      retencionesAFavorCents: sum(aFavor),
    },
  };
}

export type TaxesDetailCsvLabels = {
  sections: { sales: string; purchases: string; practicadas: string; aFavor: string };
  /** Etiqueta del impuesto documental (IVA / Impoconsumo). */
  taxLabel: (kind: "iva" | "inc") => string;
  finalConsumer: string;
  unnumbered: string;
  voided: string;
  sourceLabel: (source: string) => string;
};

/** Concepto de una fila de retención: «Nombre del concepto (236505)» o «Nombre de cuenta (236505)». */
export function retentionConceptLabel(row: RetentionRow): string {
  const name = row.conceptName ?? row.accountName;
  return name ? `${name} (${row.accountCode})` : row.accountCode;
}

/** Fecha `yyyy-mm-dd` de un ISO, leída en UTC (misma regla que `fmt.ts`). */
export function isoDay(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Filas del CSV: Sección, Fecha, Documento, NIT, Tercero, Impuesto/Concepto,
 * Tarifa, Base, Valor. Los montos van como número (= centavos) para que
 * `buildReportCsv` los escriba con coma decimal; la tarifa va como texto
 * («19 %») porque no es plata.
 */
export function taxesDetailCsvRows(
  detail: TaxesDetail,
  labels: TaxesDetailCsvLabels,
): (string | number | null)[][] {
  const doc = (section: string, r: TaxDocRow): (string | number | null)[] => [
    section,
    isoDay(r.dateIso),
    r.document,
    r.nit ?? "",
    r.party ?? labels.finalConsumer,
    labels.taxLabel(r.kind),
    `${r.pct} %`,
    r.baseCents,
    r.valorCents,
  ];
  const ret = (section: string, r: RetentionRow): (string | number | null)[] => [
    section,
    isoDay(r.dateIso),
    `${r.voucher ?? labels.unnumbered}${r.voided ? ` (${labels.voided})` : ""} · ${labels.sourceLabel(r.source)}`,
    r.nit ?? "",
    r.party ?? "",
    retentionConceptLabel(r),
    "",
    null,
    r.valorCents,
  ];
  return [
    ...detail.sales.map((r) => doc(labels.sections.sales, r)),
    ...detail.purchases.map((r) => doc(labels.sections.purchases, r)),
    ...detail.practicadas.map((r) => ret(labels.sections.practicadas, r)),
    ...detail.aFavor.map((r) => ret(labels.sections.aFavor, r)),
  ];
}
