// Lista de clientes de facturación (/operator/clientes y el buscador de
// clientes del cobro): filtros de la URL, orden, paginación y el resumen.
// Puro —sin DB— para probarlo sin base; la consulta vive en
// `billingCustomerListQueries.ts`.
//
// ── Por qué existe ────────────────────────────────────────────────────────
// Antes la API devolvía los primeros 50 clientes por nombre (`take: 50`) y
// la pantalla los pintaba tal cual, con un aviso de "se muestran hasta 50".
// Un comercio con cientos de clientes no veía al resto salvo buscándolos, y
// el buscador del cobro también se cortaba en 50 sin decirlo. Ahora la
// búsqueda, los filtros y el orden corren en la base sobre TODOS los
// clientes del comercio, y la lista se pagina.

/** Clientes por página en /operator/clientes. */
export const CUSTOMER_PAGE_SIZE = 50;
/** Resultados por tanda en el buscador del cobro / factura ("Ver más"). */
export const CUSTOMER_PICKER_PAGE_SIZE = 20;
/** Tope de `pageSize` que acepta la API. */
export const CUSTOMER_MAX_PAGE_SIZE = 50;
/** Largo máximo de la búsqueda. */
export const CUSTOMER_QUERY_MAX = 120;

/** Empresa = NIT; persona = cédula, cédula de extranjería o pasaporte. */
export type CustomerTypeFilter = "all" | "company" | "person";
export const CUSTOMER_TYPE_FILTERS: readonly CustomerTypeFilter[] = ["all", "company", "person"];

/**
 * Condición del cliente:
 *  · credit   → tiene el crédito habilitado.
 *  · debt     → debe algo hoy (aunque el crédito ya esté apagado).
 *  · overdue  → tiene deuda vencida (cargo con saldo cuyo plazo ya pasó,
 *               con los abonos aplicados FIFO, igual que Cartera).
 *  · discount → tiene descuento comercial activo.
 */
export type CustomerStatusFilter = "all" | "credit" | "debt" | "overdue" | "discount";
export const CUSTOMER_STATUS_FILTERS: readonly CustomerStatusFilter[] = [
  "all",
  "credit",
  "debt",
  "overdue",
  "discount",
];
/** Las condiciones que sólo tienen sentido si el comercio vende a crédito. */
export const CREDIT_STATUS_FILTERS: readonly CustomerStatusFilter[] = ["credit", "debt", "overdue"];

/**
 * Orden de la lista. `relevance` no sale en la pantalla: lo usa el buscador
 * del cobro (documento exacto primero, luego los nombres que empiezan por lo
 * escrito, luego el resto por nombre).
 */
export type CustomerSort = "name" | "debt" | "recent" | "relevance";
export const CUSTOMER_SORTS: readonly CustomerSort[] = ["name", "debt", "recent"];

export type CustomerListParams = {
  /** Búsqueda libre: nombre, documento o correo. */
  q: string;
  type: CustomerTypeFilter;
  status: CustomerStatusFilter;
  sort: CustomerSort;
  /** 1-based. */
  page: number;
};

export const DEFAULT_CUSTOMER_LIST_PARAMS: CustomerListParams = {
  q: "",
  type: "all",
  status: "all",
  sort: "name",
  page: 1,
};

type RawParams = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

function oneOf<T extends string>(value: string, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** Página 1-based válida; cualquier otra cosa cae a 1. */
export function parsePage(raw: string | string[] | undefined): number {
  const n = Number(first(raw));
  return Number.isSafeInteger(n) && n >= 1 && n <= 100_000 ? n : 1;
}

/**
 * Lee los filtros de la URL. Todo lo que no se entiende cae al valor por
 * defecto: una URL vieja o editada a mano nunca rompe la pantalla.
 */
export function parseCustomerListParams(sp: RawParams): CustomerListParams {
  return {
    q: first(sp.q).trim().slice(0, CUSTOMER_QUERY_MAX),
    type: oneOf(first(sp.type), CUSTOMER_TYPE_FILTERS, "all"),
    status: oneOf(first(sp.status), CUSTOMER_STATUS_FILTERS, "all"),
    sort: oneOf(first(sp.sort), CUSTOMER_SORTS, "name"),
    page: parsePage(sp.page),
  };
}

/** Query string de los filtros, sin los valores por defecto. */
export function customerListQuery(params: Partial<CustomerListParams>): string {
  const qs = new URLSearchParams();
  if (params.q) qs.set("q", params.q);
  if (params.type && params.type !== "all") qs.set("type", params.type);
  if (params.status && params.status !== "all") qs.set("status", params.status);
  if (params.sort && params.sort !== "name" && params.sort !== "relevance") qs.set("sort", params.sort);
  if (params.page && params.page > 1) qs.set("page", String(params.page));
  return qs.toString();
}

export const CUSTOMERS_PATH = "/operator/clientes";

export function customerListHref(params: Partial<CustomerListParams>): string {
  const qs = customerListQuery(params);
  return qs ? `${CUSTOMERS_PATH}?${qs}` : CUSTOMERS_PATH;
}

/** ¿Hay algo que acote la lista (para "Limpiar filtros" y el vacío)? */
export function hasCustomerFilters(params: Pick<CustomerListParams, "q" | "type" | "status">): boolean {
  return params.q !== "" || params.type !== "all" || params.status !== "all";
}

/**
 * La búsqueda tal como se compara en la base:
 *  · `text`: lo escrito, para nombre y correo (contiene, sin mayúsculas).
 *  · `document`: el número sin puntos, espacios ni "-DV" final, en
 *    mayúsculas ("901.944.469-1" → "901944469"); "" si no queda nada.
 */
export function normalizeCustomerSearch(q: string): { text: string; document: string } {
  const text = q.trim().slice(0, CUSTOMER_QUERY_MAX);
  const document = text.replace(/[.\s]/g, "").replace(/-\d$/, "").toUpperCase();
  return { text, document };
}

/** Escapa los comodines de LIKE (`%`, `_` y la barra) para buscar literal. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Tipos de documento que entran en cada filtro (null = todos). */
export function docTypesForFilter(type: CustomerTypeFilter): readonly ("CC" | "CE" | "NIT" | "PA")[] | null {
  if (type === "company") return ["NIT"];
  if (type === "person") return ["CC", "CE", "PA"];
  return null;
}

/** ¿Es una empresa? (para la etiqueta de la fila). */
export function isCompany(docType: string): boolean {
  return docType === "NIT";
}

export type PageWindow = {
  /** Página efectiva (una página más allá del final cae a la última). */
  page: number;
  pageCount: number;
  offset: number;
  /** Rango visible, 1-based e incluido ("Mostrando 51–100 de 128"); 0–0 si no hay. */
  from: number;
  to: number;
};

/** Ventana de una página sobre `total` filas. */
export function pageWindow(page: number, total: number, pageSize: number): PageWindow {
  const size = Math.max(1, Math.floor(pageSize));
  const pageCount = Math.max(1, Math.ceil(Math.max(0, total) / size));
  const effective = Math.min(Math.max(1, Math.floor(page) || 1), pageCount);
  const offset = (effective - 1) * size;
  return {
    page: effective,
    pageCount,
    offset,
    from: total > 0 ? offset + 1 : 0,
    to: Math.min(total, offset + size),
  };
}

/** `pageSize` pedido a la API, acotado; inválido = el de la pantalla. */
export function parsePageSize(raw: string | null | undefined): number {
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) return CUSTOMER_PAGE_SIZE;
  return Math.min(n, CUSTOMER_MAX_PAGE_SIZE);
}

/**
 * Totales de la lista FILTRADA (todas sus páginas, no sólo la visible).
 * La deuda total suma sólo saldos positivos: un cliente que pagó de más no
 * le resta deuda a los demás.
 */
export type CustomerListSummary = {
  count: number;
  creditCount: number;
  debtorCount: number;
  overdueCount: number;
  debtCents: number;
  overdueCents: number;
};

export const EMPTY_CUSTOMER_SUMMARY: CustomerListSummary = {
  count: 0,
  creditCount: 0,
  debtorCount: 0,
  overdueCount: 0,
  debtCents: 0,
  overdueCents: 0,
};

/** Un agregado de Postgres llega como bigint, number, string o null. */
export function toCents(value: unknown): number {
  if (value == null) return 0;
  const n = typeof value === "bigint" ? Number(value) : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** Fila del agregado SQL → resumen con números de JS. */
export function summaryFromAggregate(row: Record<string, unknown> | undefined): CustomerListSummary {
  if (!row) return EMPTY_CUSTOMER_SUMMARY;
  return {
    count: toCents(row.count),
    creditCount: toCents(row.creditCount),
    debtorCount: toCents(row.debtorCount),
    overdueCount: toCents(row.overdueCount),
    debtCents: toCents(row.debtCents),
    overdueCents: toCents(row.overdueCents),
  };
}

/**
 * Deuda vencida de un cliente a partir de dos sumas, que es lo que calcula
 * la consulta SQL:
 *
 *   vencida = max(0, Σ cargos ya vencidos − Σ abonos)
 *
 * Es exactamente lo que da aplicar los abonos FIFO (al cargo más viejo
 * primero) y sumar el saldo de los cargos vencidos, como hace Cartera: el
 * plazo es el mismo para todos los cargos del cliente, así que los
 * vencidos son siempre los más viejos y los abonos los cubren primero.
 * El test lo contrasta con `allocateFifo`.
 */
export function overdueFromTotals(overdueChargedCents: number, paidCents: number): number {
  return Math.max(0, overdueChargedCents - paidCents);
}

/**
 * ¿Ya venció un cargo? Vence el día del cobro (UTC, como Cartera) más el
 * plazo del cliente, y está vencido cuando hoy (día del comercio) es
 * posterior a ese vencimiento.
 */
export function isChargeOverdue(chargeDate: Date, termsDays: number, today: string): boolean {
  const day = Date.UTC(chargeDate.getUTCFullYear(), chargeDate.getUTCMonth(), chargeDate.getUTCDate());
  const due = new Date(day + termsDays * 86_400_000).toISOString().slice(0, 10);
  return due < today;
}
