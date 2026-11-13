/**
 * Informe de proveedores — LÓGICA PURA (sin DB ni React). Por proveedor:
 * documento (tipo, número y DV), condición de pago, total comprado en el
 * período, promedio mensual, número de facturas, última compra y saldo por
 * pagar. La carga a Prisma vive en `supplierReportQueries.ts`; la
 * exportación (Excel y CSV) en `supplierReportExport.ts`.
 *
 * ── Qué es una compra ───────────────────────────────────────────────────
 *  · Una orden de compra / factura de compra RECIBIDA (total o
 *    parcialmente), por lo recibido. Borradores, enviadas sin recibir y
 *    anuladas no cuentan (una anulada nunca tiene recepciones: la API sólo
 *    deja anular borradores y enviadas). Su fecha es la de la cartera:
 *    recepción completa, si no la primera recepción, si no la creación
 *    (`carteraQueries.poToDoc`).
 *  · Con «incluir gastos», además, los gastos NO recurrentes con proveedor
 *    (las plantillas recurrentes no son gastos: sus copias mensuales sí),
 *    por su fecha contable.
 *
 * ── Base del cálculo (`basis`) ──────────────────────────────────────────
 *  · `costo` (por defecto): lo que la compra le cuesta al comercio = neto
 *    sin IVA descontable + impuesto al consumo + IVA NO descontable (el que
 *    la recepción congeló en el costo: kardex o gasto, ver
 *    `receivedNonDeductibleTaxByLine`). En un gasto es su `amountCents`,
 *    que guarda exactamente eso.
 *  · `total`: el total facturado = neto + IVA + consumo, antes de
 *    retenciones (las retenciones son un pago a la DIAN por cuenta del
 *    proveedor, no un menor valor de la compra). Es la cifra que suelen
 *    pedir las referencias comerciales.
 *
 * ── Promedio mensual ────────────────────────────────────────────────────
 * Total del período ÷ número de meses del período, cuenten o no con
 * compras (un proveedor al que se le compró sólo en enero no «promedia»
 * lo de enero). El período es SIEMPRE de meses calendario completos; por
 * defecto los últimos 12 meses completos. Los límites son UTC, el mismo
 * convenio del resto del ERP (`period.ts`).
 */
import { computeNitDv } from "@/lib/erp/exogena";
import { expenseBaseCents } from "@/lib/erp/expenseTax";
import {
  purchaseOrderTotals,
  receivedNonDeductibleTaxByLine,
  type PurchaseInMovement,
  type PurchaseOrderAmountsInput,
  type ReceivedVatLineInput,
} from "@/lib/erp/purchaseTax";
import { supplierTaxKey } from "@/lib/erp/supplierTaxId";
import { isoDateUtc, monthRangeUtc } from "./period";

/* ─────────────────────────────── Período ─────────────────────────────── */

export const SUPPLIER_REPORT_PRESETS = ["12m", "6m", "ytd", "rango"] as const;
export type SupplierReportPreset = (typeof SUPPLIER_REPORT_PRESETS)[number];

/** Tope de un rango libre (meses): más que esto no es un promedio útil y pesa. */
export const MAX_RANGE_MONTHS = 60;

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** ¿Es un mes `yyyy-mm` válido? */
export function isMonth(v: string | null | undefined): v is string {
  return typeof v === "string" && MONTH.test(v);
}

function monthIndex(month: string): number {
  return Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
}

function monthFromIndex(i: number): string {
  const y = Math.floor(i / 12);
  return `${String(y).padStart(4, "0")}-${String((i % 12) + 1).padStart(2, "0")}`;
}

/** `yyyy-mm` desplazado `n` meses (negativo = hacia atrás). */
export function addMonths(month: string, n: number): string {
  return monthFromIndex(monthIndex(month) + n);
}

/** Meses calendario entre `from` y `to`, ambos incluidos (≥ 1 si from ≤ to). */
export function monthsInclusive(from: string, to: string): number {
  return monthIndex(to) - monthIndex(from) + 1;
}

export type SupplierReportPeriod = {
  preset: SupplierReportPreset;
  /** Primer mes (`yyyy-mm`). */
  fromMonth: string;
  /** Último mes (`yyyy-mm`), incluido. */
  toMonth: string;
  /** Divisor del promedio: meses calendario del período. */
  months: number;
  /** Primer día (ISO). */
  desde: string;
  /** Último día (ISO), incluido. */
  hasta: string;
  /** El último mes es el mes en curso (incompleto): el promedio sale bajo. */
  includesCurrentMonth: boolean;
};

function buildPeriod(
  preset: SupplierReportPreset,
  fromMonth: string,
  toMonth: string,
  currentMonth: string,
): SupplierReportPeriod {
  return {
    preset,
    fromMonth,
    toMonth,
    months: monthsInclusive(fromMonth, toMonth),
    desde: `${fromMonth}-01`,
    hasta: monthRangeUtc(toMonth)!.hasta,
    includesCurrentMonth: toMonth === currentMonth,
  };
}

/**
 * Período efectivo a partir de la URL. `today` es la fecha local del
 * comercio (`todayIso`).
 *
 *  · `12m` (por defecto): los 12 meses completos anteriores al mes en curso.
 *  · `6m`: los 6 meses completos anteriores.
 *  · `ytd`: de enero al último mes completo; en enero (aún sin meses
 *    completos en el año) es enero en curso, marcado como incompleto.
 *  · `rango`: de `desde` a `hasta` (`yyyy-mm`). Se ordenan si vienen al
 *    revés, `hasta` no pasa del mes en curso y el rango se recorta a los
 *    últimos `MAX_RANGE_MONTHS`. Un rango inválido cae al default.
 */
export function resolveSupplierReportPeriod(
  q: { periodo?: string | null; desde?: string | null; hasta?: string | null },
  today: string,
): SupplierReportPeriod {
  const current = today.slice(0, 7);
  const lastComplete = addMonths(current, -1);
  const preset = (SUPPLIER_REPORT_PRESETS as readonly string[]).includes(q.periodo ?? "")
    ? (q.periodo as SupplierReportPreset)
    : "12m";

  if (preset === "rango" && isMonth(q.desde) && isMonth(q.hasta)) {
    let from = q.desde <= q.hasta ? q.desde : q.hasta;
    let to = q.desde <= q.hasta ? q.hasta : q.desde;
    if (to > current) to = current;
    if (from > to) from = to;
    if (monthsInclusive(from, to) > MAX_RANGE_MONTHS) from = addMonths(to, -(MAX_RANGE_MONTHS - 1));
    return buildPeriod("rango", from, to, current);
  }
  if (preset === "6m") return buildPeriod("6m", addMonths(lastComplete, -5), lastComplete, current);
  if (preset === "ytd") {
    const january = `${today.slice(0, 4)}-01`;
    return buildPeriod("ytd", january, lastComplete < january ? january : lastComplete, current);
  }
  return buildPeriod("12m", addMonths(lastComplete, -11), lastComplete, current);
}

/* ──────────────────────────── Query de la URL ─────────────────────────── */

export const SUPPLIER_REPORT_BASES = ["costo", "total"] as const;
export type SupplierReportBasis = (typeof SUPPLIER_REPORT_BASES)[number];

export const PAYMENT_CONDITIONS = ["todas", "contado", "credito"] as const;
export type PaymentConditionFilter = (typeof PAYMENT_CONDITIONS)[number];

export const SUPPLIER_SORT_KEYS = [
  "proveedor",
  "nit",
  "condicion",
  "promedio",
  "total",
  "facturas",
  "ultima",
  "saldo",
] as const;
export type SupplierSortKey = (typeof SUPPLIER_SORT_KEYS)[number];
export type SortDir = "asc" | "desc";

/** Dirección con la que arranca cada columna: textos A→Z, cifras y fechas de mayor a menor. */
export const DEFAULT_SORT_DIR: Record<SupplierSortKey, SortDir> = {
  proveedor: "asc",
  nit: "asc",
  condicion: "asc",
  promedio: "desc",
  total: "desc",
  facturas: "desc",
  ultima: "desc",
  saldo: "desc",
};

export const DEFAULT_SORT: SupplierSortKey = "promedio";
export const SUPPLIER_REPORT_PAGE_SIZE = 50;
const MAX_QUERY_LENGTH = 80;

export type SupplierReportQuery = {
  period: SupplierReportPeriod;
  basis: SupplierReportBasis;
  includeExpenses: boolean;
  /** Búsqueda por nombre o documento (recortada). */
  q: string;
  condition: PaymentConditionFilter;
  sort: SupplierSortKey;
  dir: SortDir;
  /** Página pedida (≥ 1; la paginación la acota al total). */
  page: number;
};

function oneOf<T extends string>(list: readonly T[], v: string | undefined, fallback: T): T {
  return v !== undefined && (list as readonly string[]).includes(v) ? (v as T) : fallback;
}

/**
 * Query de la pantalla y de la exportación (`?periodo&desde&hasta&base&
 * gastos&q&condicion&orden&dir&pagina`). Todo valor inválido cae a su
 * default: un enlace viejo o tocado a mano nunca rompe el reporte.
 */
export function parseSupplierReportQuery(
  raw: Record<string, string | undefined>,
  today: string,
): SupplierReportQuery {
  const sort = oneOf(SUPPLIER_SORT_KEYS, raw.orden, DEFAULT_SORT);
  const page = Number(raw.pagina);
  return {
    period: resolveSupplierReportPeriod(raw, today),
    basis: oneOf(SUPPLIER_REPORT_BASES, raw.base, "costo"),
    includeExpenses: raw.gastos !== "no",
    q: (raw.q ?? "").trim().slice(0, MAX_QUERY_LENGTH),
    condition: oneOf(PAYMENT_CONDITIONS, raw.condicion, "todas"),
    sort,
    dir: raw.dir === "asc" || raw.dir === "desc" ? raw.dir : DEFAULT_SORT_DIR[sort],
    page: Number.isInteger(page) && page > 1 ? page : 1,
  };
}

/**
 * La query como parámetros de URL, sin los valores por defecto (enlaces
 * cortos y estables). `format` y `pagina` los agrega quien los necesite.
 */
export function supplierReportSearchParams(
  q: SupplierReportQuery,
  { page = q.page }: { page?: number } = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  if (q.period.preset !== "12m") out.periodo = q.period.preset;
  if (q.period.preset === "rango") {
    out.desde = q.period.fromMonth;
    out.hasta = q.period.toMonth;
  }
  if (q.basis !== "costo") out.base = q.basis;
  if (!q.includeExpenses) out.gastos = "no";
  if (q.q) out.q = q.q;
  if (q.condition !== "todas") out.condicion = q.condition;
  if (q.sort !== DEFAULT_SORT) out.orden = q.sort;
  if (q.dir !== DEFAULT_SORT_DIR[q.sort]) out.dir = q.dir;
  if (page > 1) out.pagina = String(page);
  return out;
}

/** Orden al tocar el encabezado de una columna: la misma alterna, otra arranca en su default. */
export function nextSort(q: Pick<SupplierReportQuery, "sort" | "dir">, key: SupplierSortKey): { sort: SupplierSortKey; dir: SortDir } {
  if (q.sort === key) return { sort: key, dir: q.dir === "asc" ? "desc" : "asc" };
  return { sort: key, dir: DEFAULT_SORT_DIR[key] };
}

/* ─────────────────────────── Documento del proveedor ─────────────────────────── */

export type SupplierDocument = {
  /** NIT | CC | CE | PA…; null si no se capturó y no parece un NIT. */
  type: string | null;
  number: string;
  /** Dígito de verificación (sólo NIT): el guardado o, si no hay, el calculado. */
  dv: string | null;
};

/**
 * Del `taxId` libre (+ el tipo explícito, si lo hay) a tipo, número y DV.
 * Misma inferencia que la exógena (`supplierTercero`): sin tipo explícito,
 * es NIT si trae DV («900123456-7») o si son 9 dígitos que empiezan por 8
 * o 9 (persona jurídica); si no, el tipo queda en blanco en vez de adivinar.
 */
export function supplierDocument(
  taxId: string | null | undefined,
  taxIdType: string | null | undefined,
): SupplierDocument | null {
  const raw = (taxId ?? "").trim().replace(/^nit\.?\s*/i, "");
  if (!raw) return null;
  let base = raw;
  let dv: string | null = null;
  const m = /^(.*\d)\s*-\s*(\d)$/.exec(raw);
  if (m) {
    base = m[1]!;
    dv = m[2]!;
  }
  const digits = base.replace(/\D/g, "");
  const explicit = taxIdType?.trim().toUpperCase() || null;
  const looksLikeNit = digits.length === 9 && /^[89]/.test(digits);
  const type = explicit ?? (dv || looksLikeNit ? "NIT" : null);
  if (type !== "NIT") return { type, number: base.trim(), dv: null };
  return { type, number: digits || base.trim(), dv: dv ?? (digits ? computeNitDv(digits) : null) };
}

/** «NIT 900123456-7», «CC 1020304050» o el número solo. */
export function formatSupplierDocument(d: SupplierDocument | null): string {
  if (!d) return "";
  const number = d.dv ? `${d.number}-${d.dv}` : d.number;
  return d.type ? `${d.type} ${number}` : number;
}

/** Plazo normalizado: null = contado (sin plazo o plazo 0). */
export function creditDays(paymentTermsDays: number | null | undefined): number | null {
  return paymentTermsDays != null && paymentTermsDays > 0 ? paymentTermsDays : null;
}

/* ──────────────────────────── Documentos de compra ──────────────────────────── */

export type SupplierPurchaseDoc = {
  supplierId: string;
  source: "purchase_order" | "expense";
  /** Fecha del documento (ISO, día UTC). */
  date: string;
  /** Base «costo»: neto + consumo + IVA no descontable. */
  costCents: number;
  /** Base «total»: neto + IVA + consumo (antes de retenciones). */
  invoicedCents: number;
};

/** Estados de una OC que ya son compra (algo se recibió). */
export const COUNTED_PURCHASE_STATUSES = ["received", "partially_received"] as const;

export type SupplierPurchaseOrderInput = Omit<PurchaseOrderAmountsInput, "items"> & {
  supplierId: string;
  status: string;
  receivedAt: Date | null;
  createdAt: Date;
  items: readonly ReceivedVatLineInput[];
  /** Movimientos `purchase_in` de la OC (las recepciones). */
  movements: readonly (PurchaseInMovement & { createdAt: Date })[];
};

/** Fecha de la compra: la de la cartera (recepción completa → primera recepción → creación). */
export function purchaseOrderDate(po: {
  receivedAt: Date | null;
  createdAt: Date;
  movements: readonly { createdAt: Date }[];
}): Date {
  if (po.receivedAt) return po.receivedAt;
  let first: Date | null = null;
  for (const m of po.movements) if (!first || m.createdAt < first) first = m.createdAt;
  return first ?? po.createdAt;
}

/** OC → documento de compra (null si no es compra: borrador, enviada o anulada). */
export function purchaseOrderSupplierDoc(po: SupplierPurchaseOrderInput): SupplierPurchaseDoc | null {
  if (!(COUNTED_PURCHASE_STATUSES as readonly string[]).includes(po.status)) return null;
  const totals = purchaseOrderTotals(po, "received");
  const nonDeductible = receivedNonDeductibleTaxByLine(po.items, po.movements).reduce((s, c) => s + c, 0);
  return {
    supplierId: po.supplierId,
    source: "purchase_order",
    date: isoDateUtc(purchaseOrderDate(po)),
    costCents: totals.subtotalCents + totals.incCents + Math.min(nonDeductible, totals.taxCents),
    invoicedCents: totals.subtotalCents + totals.taxCents + totals.incCents,
  };
}

export type SupplierExpenseInput = {
  supplierId: string | null;
  recurring?: boolean;
  date: Date;
  amountCents: number;
  baseCents?: number | null;
  ivaCents?: number | null;
  incCents?: number | null;
};

/** Gasto → documento de compra (null sin proveedor o si es la plantilla recurrente). */
export function expenseSupplierDoc(e: SupplierExpenseInput): SupplierPurchaseDoc | null {
  if (!e.supplierId || e.recurring) return null;
  return {
    supplierId: e.supplierId,
    source: "expense",
    date: isoDateUtc(e.date),
    costCents: e.amountCents,
    invoicedCents: expenseBaseCents(e) + (e.ivaCents ?? 0) + (e.incCents ?? 0),
  };
}

/* ──────────────────────────────── Agregado ──────────────────────────────── */

export type SupplierReportSupplier = {
  id: string;
  name: string;
  taxId: string | null;
  taxIdType: string | null;
  paymentTermsDays: number | null;
  active: boolean;
};

export type SupplierReportRow = {
  supplierId: string;
  name: string;
  active: boolean;
  document: SupplierDocument | null;
  /** Días de crédito; null = contado. */
  creditDays: number | null;
  totalCents: number;
  averageCents: number;
  invoices: number;
  /** Última compra (ISO) hasta hoy, dentro o fuera del período; null si nunca. */
  lastPurchase: string | null;
  payableCents: number;
};

export type SupplierReportTotals = {
  suppliers: number;
  withPurchases: number;
  totalCents: number;
  averageCents: number;
  invoices: number;
  payableCents: number;
};

/**
 * Una fila por proveedor del comercio: los activos siempre (también sin
 * compras: promedio 0), los inactivos sólo si compraron en el período o
 * se les debe. Los documentos de proveedores ajenos al listado (otro
 * comercio) o fuera del período se ignoran.
 */
export function buildSupplierReport(input: {
  suppliers: readonly SupplierReportSupplier[];
  docs: readonly SupplierPurchaseDoc[];
  period: Pick<SupplierReportPeriod, "desde" | "hasta" | "months">;
  basis: SupplierReportBasis;
  /** Última compra de cada proveedor hasta hoy (ISO), de toda la historia. */
  lastPurchase?: ReadonlyMap<string, string>;
  /** Saldo por pagar de cada proveedor hoy. */
  payables?: ReadonlyMap<string, number>;
}): SupplierReportRow[] {
  const { period, basis } = input;
  const acc = new Map<string, { total: number; invoices: number; last: string | null }>();
  for (const s of input.suppliers) acc.set(s.id, { total: 0, invoices: 0, last: input.lastPurchase?.get(s.id) ?? null });
  for (const d of input.docs) {
    const a = acc.get(d.supplierId);
    if (!a || d.date < period.desde || d.date > period.hasta) continue;
    a.total += basis === "total" ? d.invoicedCents : d.costCents;
    a.invoices += 1;
    if (!a.last || d.date > a.last) a.last = d.date;
  }
  const months = Math.max(1, period.months);
  const rows: SupplierReportRow[] = [];
  for (const s of input.suppliers) {
    const a = acc.get(s.id)!;
    const payableCents = input.payables?.get(s.id) ?? 0;
    if (!s.active && a.invoices === 0 && payableCents === 0) continue;
    rows.push({
      supplierId: s.id,
      name: s.name,
      active: s.active,
      document: supplierDocument(s.taxId, s.taxIdType),
      creditDays: creditDays(s.paymentTermsDays),
      totalCents: a.total,
      averageCents: Math.round(a.total / months),
      invoices: a.invoices,
      lastPurchase: a.last,
      payableCents,
    });
  }
  return rows;
}

/** Totales de un conjunto de filas (las filtradas, no sólo la página). */
export function supplierReportTotals(rows: readonly SupplierReportRow[], months: number): SupplierReportTotals {
  const totalCents = rows.reduce((s, r) => s + r.totalCents, 0);
  return {
    suppliers: rows.length,
    withPurchases: rows.filter((r) => r.invoices > 0).length,
    totalCents,
    averageCents: Math.round(totalCents / Math.max(1, months)),
    invoices: rows.reduce((s, r) => s + r.invoices, 0),
    payableCents: rows.reduce((s, r) => s + r.payableCents, 0),
  };
}

/* ─────────────────────── Búsqueda, filtro, orden y página ─────────────────────── */

/** Minúsculas y sin tildes, para buscar «panaderia» y encontrar «Panadería». */
function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** ¿La fila coincide con la búsqueda? Por nombre o por número de documento (sin puntos ni DV). */
export function matchesSupplierSearch(row: Pick<SupplierReportRow, "name" | "document">, q: string): boolean {
  const query = q.trim();
  if (!query) return true;
  if (fold(row.name).includes(fold(query))) return true;
  const key = /\d/.test(query) ? supplierTaxKey(query) : null;
  if (!key || !row.document) return false;
  return (supplierTaxKey(row.document.number) ?? "").includes(key);
}

export function filterSupplierRows(
  rows: readonly SupplierReportRow[],
  { q, condition }: Pick<SupplierReportQuery, "q" | "condition">,
): SupplierReportRow[] {
  return rows.filter(
    (r) =>
      matchesSupplierSearch(r, q) &&
      (condition === "todas" || (condition === "contado") === (r.creditDays === null)),
  );
}

const collator = new Intl.Collator("es", { sensitivity: "base", numeric: true });

/** Valor de orden; null = sin dato (va siempre al final, en cualquier dirección). */
function sortValue(r: SupplierReportRow, key: SupplierSortKey): string | number | null {
  switch (key) {
    case "proveedor":
      return r.name;
    case "nit":
      return r.document?.number ?? null;
    case "condicion":
      return r.creditDays ?? 0;
    case "promedio":
      return r.averageCents;
    case "total":
      return r.totalCents;
    case "facturas":
      return r.invoices;
    case "ultima":
      return r.lastPurchase;
    case "saldo":
      return r.payableCents;
  }
}

/** Orden estable por la columna pedida; a igualdad, por nombre A→Z. */
export function sortSupplierRows(
  rows: readonly SupplierReportRow[],
  sort: SupplierSortKey,
  dir: SortDir,
): SupplierReportRow[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = sortValue(a, sort);
    const vb = sortValue(b, sort);
    if (va !== vb) {
      if (va === null) return 1;
      if (vb === null) return -1;
      const c = typeof va === "number" && typeof vb === "number" ? va - vb : collator.compare(String(va), String(vb));
      if (c !== 0) return c * sign;
    }
    return collator.compare(a.name, b.name) || a.supplierId.localeCompare(b.supplierId);
  });
}

export type SupplierReportPage = {
  rows: SupplierReportRow[];
  /** Página efectiva (acotada a [1, pages]). */
  page: number;
  pages: number;
  /** Filas filtradas en total (todas las páginas). */
  total: number;
  /** Posición (1-based) de la primera y la última fila de la página; 0 si no hay filas. */
  from: number;
  to: number;
};

export function paginateSupplierRows(
  rows: readonly SupplierReportRow[],
  page: number,
  pageSize = SUPPLIER_REPORT_PAGE_SIZE,
): SupplierReportPage {
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const p = Math.min(Math.max(1, Math.floor(page)), pages);
  const start = (p - 1) * pageSize;
  const slice = rows.slice(start, start + pageSize);
  return {
    rows: slice,
    page: p,
    pages,
    total: rows.length,
    from: slice.length > 0 ? start + 1 : 0,
    to: start + slice.length,
  };
}

/** Filtra y ordena TODAS las filas (la exportación) — la página sale de `paginateSupplierRows`. */
export function applySupplierReportView(
  rows: readonly SupplierReportRow[],
  q: Pick<SupplierReportQuery, "q" | "condition" | "sort" | "dir">,
): SupplierReportRow[] {
  return sortSupplierRows(filterSupplierRows(rows, q), q.sort, q.dir);
}
