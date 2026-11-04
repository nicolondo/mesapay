/**
 * Composición del DESPLIEGUE de impuestos: lee con `taxesQueries.ts` (lo
 * mismo que el reporte de siempre) y `taxesDrillQueries.ts` (lo que el
 * despliegue y las revisiones necesitan además) y calcula con los módulos
 * puros. Lo comparten la página y la API de auxiliares para que el nivel 3
 * que se abre diga exactamente lo mismo que los niveles 1 y 2 en pantalla.
 *
 * VENTANA: el documental corta por la fecha UTC del documento; el motor
 * asienta por DÍA DE NEGOCIO (Bogotá + hora de corte), que se desborda
 * hasta 29 h pasado el último día. Ventas y compras se leen hasta el final
 * del último día de negocio y se separan acá: el documental se queda con
 * las de fecha dentro del período; la reconciliación usa toda la ventana
 * para saber cuáles asienta el libro en el período.
 *
 * CACHÉ: la página arma los datos y los deja 60 s en memoria del proceso;
 * los auxiliares que se abren enseguida (API) salen de esa misma foto, así
 * no se repiten las consultas y la fila 3 suma lo que la fila 2 mostró.
 * Clave = comercio + período (nunca cruza comercios).
 */
import { bogotaDayRange } from "@/lib/bogota";
import { docAuxRow, ledgerAuxRow, type AuxFlag, type AuxRow } from "./auxRows";
import { periodToUtcRange, type ReportPeriod } from "./period";
import { runTaxChecks, type ChecksInput, type CheckResult } from "./taxesChecks";
import {
  buildTaxDrill,
  creditNoteFacts,
  ledgerFacts,
  ORIGIN_SOURCE,
  purchaseFacts,
  refundFacts,
  salesFacts,
  selectAux,
  type DocFact,
  type DrillFacts,
  type TaxDrill,
} from "./taxesDrill";
import {
  loadDianCreditNotes,
  loadDianInvoiceStates,
  loadDrillTenant,
  loadEngineEntries,
  loadEngineOrders,
  loadRetentionConceptsFull,
  loadSaleTaxTrendDocs,
  type DrillTenant,
} from "./taxesDrillQueries";
import type { CurrentSalesTax } from "./taxesDocuments";
import { TAX_ACCOUNT_PREFIXES } from "./taxesModel";
import {
  loadCreditNoteTaxDocs,
  loadCurrentSalesTax,
  loadPurchaseTaxDocs,
  loadRefundsCents,
  loadSaleTaxDocs,
  loadTaxAccounts,
  loadTaxLedgerLines,
} from "./taxesQueries";
import { engineDay, reconcileTaxes, type Reconciliation } from "./taxesReconcile";
import { buildTaxTrend, trendPeriods, type TaxTrend } from "./taxesTrend";

export type TaxesDrillBase = {
  period: ReportPeriod;
  tenant: DrillTenant;
  currentTax: CurrentSalesTax;
  facts: DrillFacts;
  drill: TaxDrill;
  recon: Reconciliation;
  /** Entradas de las revisiones, sin la tendencia (la añade la página). */
  checksInput: ChecksInput;
};

/**
 * Hechos documentales de orígenes que el reporte todavía no trae.
 * EXTENSIÓN «gastos»: cuando `taxesQueries` exponga los gastos con impuesto
 * y retenciones (rama `feat/gastos-impuestos`), se cargan junto a las
 * compras y se mapean con `purchaseFacts(gastos, concepts, "gastos")` (o un
 * mapeo propio con `origin: "gastos"`); el árbol, la reconciliación (fuente
 * `expense`, por fecha contable) y las revisiones ya los tratan como un
 * origen más.
 */
function extraDocFacts(): DocFact[] {
  return [];
}

const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 16;
const cache = new Map<string, { at: number; value: TaxesDrillBase }>();

function cacheKey(restaurantId: string, period: ReportPeriod) {
  return `${restaurantId}|${period.desde}|${period.hasta}`;
}

/** Datos del despliegue (niveles 1–3, reconciliación y entradas de las revisiones). */
export async function loadTaxesDrillBase(
  restaurantId: string,
  period: ReportPeriod,
  opts: { useCache?: boolean } = {},
): Promise<TaxesDrillBase> {
  const key = cacheKey(restaurantId, period);
  if (opts.useCache) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  }
  const value = await computeBase(restaurantId, period);
  cache.set(key, { at: Date.now(), value });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return value;
}

/** Sólo para tests. */
export function clearTaxesDrillCache() {
  cache.clear();
}

async function computeBase(restaurantId: string, period: ReportPeriod): Promise<TaxesDrillBase> {
  const { from, to } = periodToUtcRange(period);
  const [tenant, concepts] = await Promise.all([
    loadDrillTenant(restaurantId),
    loadRetentionConceptsFull(restaurantId),
  ]);
  const bizEnd = bogotaDayRange(period.hasta, tenant.cutoffHour).end;
  const windowTo = bizEnd > to ? bizEnd : to;
  const conceptKindByCode = new Map<string, string>();
  for (const c of concepts) if (!conceptKindByCode.has(c.accountCode)) conceptKindByCode.set(c.accountCode, c.kind);
  const codes = [...conceptKindByCode.keys()];

  const [windowSales, windowPurchases, creditNotes, refundsCents, currentTax, accounts, lines, engine, entries, dianCreditNotes] =
    await Promise.all([
      loadSaleTaxDocs(restaurantId, from, windowTo),
      loadPurchaseTaxDocs(restaurantId, from, windowTo),
      loadCreditNoteTaxDocs(restaurantId, period.desde, period.hasta),
      loadRefundsCents(restaurantId, from, to),
      loadCurrentSalesTax(restaurantId),
      loadTaxAccounts(restaurantId, TAX_ACCOUNT_PREFIXES, codes),
      loadTaxLedgerLines(restaurantId, from, to, TAX_ACCOUNT_PREFIXES, codes),
      loadEngineOrders(restaurantId, from, windowTo, tenant),
      loadEngineEntries(restaurantId, from, to),
      loadDianCreditNotes(restaurantId, from, to),
    ]);
  const inUtcPeriod = (iso: string) => Date.parse(iso) < to.getTime();
  const sales = windowSales.filter((s) => inUtcPeriod(s.dateIso));
  const purchases = windowPurchases.filter((p) => inUtcPeriod(p.dateIso));
  const rates = concepts.map((c) => ({ kind: c.kind, name: c.name, rateBps: c.rateBps, active: c.active }));

  const docs: DocFact[] = [
    ...salesFacts(sales),
    ...creditNoteFacts(creditNotes),
    ...refundFacts(refundsCents, sales, currentTax, `${period.hasta}T12:00:00.000Z`),
    ...purchaseFacts(purchases, rates),
    ...extraDocFacts(),
  ];
  const ledger = ledgerFacts(lines, accounts, conceptKindByCode);
  const facts = { docs, ledger };
  const recon = reconcileTaxes({
    period,
    cutoffHour: tenant.cutoffHour,
    docs,
    windowSaleFacts: salesFacts(windowSales),
    windowPurchaseFacts: purchaseFacts(windowPurchases, rates),
    orders: engine.orders,
    ledger,
    entries,
  });
  const dianInvoices = await loadDianInvoiceStates(
    restaurantId,
    sales.map((s) => s.invoiceId),
  );
  const checksInput: ChecksInput = {
    recon,
    sales,
    purchases,
    docs,
    currentTax,
    purchaseIvaDeductible: tenant.purchaseIvaDeductible,
    concepts,
    uvtCents: tenant.uvtCents,
    cutoffHour: tenant.cutoffHour,
    entries,
    dianInvoices,
    dianCreditNotes,
    freeLineTaxByInvoice: engine.freeLineTaxByInvoice,
  };
  return { period, tenant, currentTax, facts, drill: buildTaxDrill(facts), recon, checksInput };
}

/** Tendencia de los últimos períodos del mismo tipo (documental, como las teselas). */
export async function loadTaxesTrend(restaurantId: string, period: ReportPeriod): Promise<TaxTrend> {
  const periods = trendPeriods(period);
  const first = periods[0]!;
  const { from } = periodToUtcRange(first);
  const { to } = periodToUtcRange(period);
  const [currentTax, sales, purchases, creditNotes, ...refunds] = await Promise.all([
    loadCurrentSalesTax(restaurantId),
    loadSaleTaxTrendDocs(restaurantId, from, to),
    loadPurchaseTaxDocs(restaurantId, from, to),
    loadCreditNoteTaxDocs(restaurantId, first.desde, period.hasta),
    ...periods.map((p) => {
      const r = periodToUtcRange(p);
      return loadRefundsCents(restaurantId, r.from, r.to);
    }),
  ]);
  return buildTaxTrend({
    buckets: periods.map((p, i) => ({ period: p, refundsCents: (refunds[i] as number | undefined) ?? 0 })),
    sales,
    purchases,
    creditNotes,
    currentTax,
  });
}

/** Revisiones del período (con la tendencia si se pasa). */
export function taxChecks(base: TaxesDrillBase, trend?: TaxTrend): CheckResult[] {
  return runTaxChecks({ ...base.checksInput, trend: trend?.series });
}

/** Prefijo de los ids de las revisiones en la URL y en la API (`alerta-sinFactura`). */
export const CHECK_ID_PREFIX = "alerta-";

/**
 * Filas de auxiliar de un renglón: los documentos o líneas del libro de un
 * renglón de nivel 2 (o de «otros»), o las filas de una revisión. Los
 * documentos llevan el asiento del motor que los contabilizó y, si son
 * facturas electrónicas con problemas, su marca DIAN. null = id desconocido.
 */
export function auxRowsForNode(
  base: TaxesDrillBase,
  nodeId: string,
): { kind: "docs" | "ledger" | "check"; rows: AuxRow[] } | null {
  if (nodeId.startsWith(CHECK_ID_PREFIX)) {
    const key = nodeId.slice(CHECK_ID_PREFIX.length);
    const check = taxChecks(base).find((c) => c.key === key);
    return check ? { kind: "check", rows: check.rows } : null;
  }
  const sel = selectAux(base.facts, nodeId);
  if (!sel) return null;
  if (sel.kind === "ledger") return { kind: "ledger", rows: sel.rows.map(ledgerAuxRow) };
  const entryOf = new Map<string, { id: string; voucher: string | null }>();
  for (const e of base.checksInput.entries) entryOf.set(`${e.source}|${e.day}`, { id: e.id, voucher: e.voucher ?? null });
  const rows = sel.rows.map((f) => {
    const day = engineDay(f.origin, f.dateIso, base.tenant.cutoffHour);
    const entry = day ? entryOf.get(`${ORIGIN_SOURCE[f.origin]}|${day}`) : undefined;
    const entryId = entry?.id ?? null;
    const dian = f.docKind === "invoice" && f.docId ? base.checksInput.dianInvoices.get(f.docId) : undefined;
    const flags: AuxFlag[] = [];
    if (f.docKind === "refund") flags.push("estimated");
    if (dian?.state === "rejected") flags.push("dianRejected");
    else if (dian && dian.state !== "accepted") flags.push("dianPending");
    if (day && !entryId) flags.push("noEntry");
    return { ...docAuxRow(f, { entryId, day, flags }), voucher: entry?.voucher ?? null };
  });
  return { kind: "docs", rows };
}
