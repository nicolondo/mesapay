/**
 * Composición de los dos reportes de impuestos: lee con `taxesQueries.ts`
 * y calcula con los módulos puros. Lo comparten la página y la ruta API
 * para que pantalla y JSON/CSV salgan de la misma cifra.
 */
import { periodToUtcRange, type ReportPeriod } from "./period";
import { buildTaxCross, type CrossRow } from "./taxesCross";
import { buildTaxesDetail, type TaxesDetail } from "./taxesDetail";
import { aggregateDocumentTaxes, type DocumentTaxes } from "./taxesDocuments";
import {
  buildTaxAccountReport,
  RETENTION_PREFIXES,
  TAX_ACCOUNT_PREFIXES,
  type TaxAccountReport,
} from "./taxesModel";
import {
  loadCurrentSalesTax,
  loadPurchaseTaxDocs,
  loadRefundsCents,
  loadRetentionConceptRows,
  loadSaleTaxDocs,
  loadTaxAccounts,
  loadTaxLedgerLines,
  type RetentionConceptRow,
} from "./taxesQueries";

export type TaxesReport = {
  documental: DocumentTaxes;
  book: TaxAccountReport;
  cross: CrossRow[];
  /** Centavos. */
  stats: { generados: number; ivaGenerado: number; incGenerado: number };
};

function conceptMaps(concepts: readonly RetentionConceptRow[]) {
  const conceptKindByCode = new Map<string, string>();
  const conceptsByCode = new Map<string, { kind: string; name: string }>();
  for (const c of concepts) {
    if (!conceptKindByCode.has(c.accountCode)) conceptKindByCode.set(c.accountCode, c.kind);
    // Con varios conceptos sobre la misma cuenta gana el ACTIVO (es el que
    // liquida); si ninguno está activo, el primero por nombre.
    const prev = conceptsByCode.get(c.accountCode);
    if (!prev || c.active) conceptsByCode.set(c.accountCode, { kind: c.kind, name: c.name });
  }
  return { conceptKindByCode, conceptsByCode, codes: [...conceptKindByCode.keys()] };
}

/** Impuestos del período: documental + libro + cruce. */
export async function loadTaxesReport(
  restaurantId: string,
  period: ReportPeriod,
): Promise<TaxesReport> {
  const { from, to } = periodToUtcRange(period);
  const concepts = await loadRetentionConceptRows(restaurantId);
  const { conceptKindByCode, codes } = conceptMaps(concepts);
  const [sales, purchases, refundsCents, currentTax, accounts, lines] = await Promise.all([
    loadSaleTaxDocs(restaurantId, from, to),
    loadPurchaseTaxDocs(restaurantId, from, to),
    loadRefundsCents(restaurantId, from, to),
    loadCurrentSalesTax(restaurantId),
    loadTaxAccounts(restaurantId, TAX_ACCOUNT_PREFIXES, codes),
    loadTaxLedgerLines(restaurantId, from, to, TAX_ACCOUNT_PREFIXES, codes),
  ]);
  const documental = aggregateDocumentTaxes({ sales, purchases, refundsCents, currentTax });
  const book = buildTaxAccountReport(lines, accounts, { conceptKindByCode });
  const cross = buildTaxCross(documental, book);
  return {
    documental,
    book,
    cross,
    stats: {
      generados: documental.totals.generadosCents,
      ivaGenerado: documental.totals.ivaGeneradoCents,
      incGenerado: documental.totals.incGeneradoCents,
    },
  };
}

/** Impuestos detallados: documento por documento. */
export async function loadTaxesDetailReport(
  restaurantId: string,
  period: ReportPeriod,
): Promise<TaxesDetail> {
  const { from, to } = periodToUtcRange(period);
  const concepts = await loadRetentionConceptRows(restaurantId);
  const { conceptsByCode, codes } = conceptMaps(concepts);
  const [sales, purchases, accounts, ledgerLines] = await Promise.all([
    loadSaleTaxDocs(restaurantId, from, to),
    loadPurchaseTaxDocs(restaurantId, from, to),
    loadTaxAccounts(restaurantId, RETENTION_PREFIXES, codes),
    loadTaxLedgerLines(restaurantId, from, to, RETENTION_PREFIXES, codes),
  ]);
  return buildTaxesDetail({ sales, purchases, ledgerLines, accounts, conceptsByCode });
}
