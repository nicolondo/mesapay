// Lista de facturas electrónicas de /operator/facturas (con el módulo
// `einvoicing`): filtros de la URL, el `where` de Prisma y el estado DIAN
// que ve el operador. Puro —sin DB— para poder probar filtros, búsqueda y
// paginación sin base; las consultas viven en `invoiceListQueries.ts`.
import type { Prisma } from "@prisma/client";
import { addDaysIso, bogotaBusinessDateIso, bogotaDayRange } from "@/lib/bogota";
import { MAX_ATTEMPTS } from "@/lib/dian/retry";

/** Facturas por página. */
export const INVOICE_PAGE_SIZE = 50;

/** Filtro por estado DIAN de la lista. */
export type InvoiceStateFilter = "all" | "rejected" | "in_process" | "accepted";
export const INVOICE_STATE_FILTERS: readonly InvoiceStateFilter[] = [
  "all",
  "rejected",
  "in_process",
  "accepted",
];

export type InvoiceListParams = {
  state: InvoiceStateFilter;
  /** Día operativo (YYYY-MM-DD) desde el que se lista, incluido. */
  from: string | null;
  /** Día operativo (YYYY-MM-DD) hasta el que se lista, incluido. */
  to: string | null;
  /** Búsqueda libre: número, código de pedido, NIT, nombre o correo. */
  q: string;
  /** 1-based. */
  page: number;
};

export const DEFAULT_INVOICE_LIST_PARAMS: InvoiceListParams = {
  state: "all",
  from: null,
  to: null,
  q: "",
  page: 1,
};

type RawParams = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

function isoDay(v: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const [y, m, d] = v.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  // 2026-02-31 no existe: Date lo corre a marzo y deja de coincidir.
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
    ? v
    : null;
}

/**
 * Lee los filtros de la URL. Todo lo que no se entiende cae al valor por
 * defecto (una URL vieja o editada a mano nunca rompe la pantalla). Un rango
 * al revés se da vuelta.
 */
export function parseInvoiceListParams(sp: RawParams): InvoiceListParams {
  const rawState = first(sp.state);
  const state = (INVOICE_STATE_FILTERS as readonly string[]).includes(rawState)
    ? (rawState as InvoiceStateFilter)
    : "all";
  let from = isoDay(first(sp.from));
  let to = isoDay(first(sp.to));
  if (from && to && from > to) [from, to] = [to, from];
  const q = first(sp.q).trim().slice(0, 100);
  const pageNum = Number(first(sp.page));
  const page = Number.isSafeInteger(pageNum) && pageNum >= 1 && pageNum <= 100_000 ? pageNum : 1;
  return { state, from, to, q, page };
}

/** Query string de los filtros, sin los valores por defecto. */
export function invoiceListQuery(params: Partial<InvoiceListParams>): string {
  const qs = new URLSearchParams();
  if (params.state && params.state !== "all") qs.set("state", params.state);
  if (params.from) qs.set("from", params.from);
  if (params.to) qs.set("to", params.to);
  if (params.q) qs.set("q", params.q);
  if (params.page && params.page > 1) qs.set("page", String(params.page));
  return qs.toString();
}

export function invoiceListHref(params: Partial<InvoiceListParams>): string {
  const qs = invoiceListQuery(params);
  return qs ? `/operator/facturas?${qs}` : "/operator/facturas";
}

/**
 * Estado DIAN que ve el operador, a partir del documento:
 *
 *   · accepted → aceptada.
 *   · rejected → la DIAN la evaluó y no la aceptó (no se reintenta sola).
 *   · error    → falla de canal o de armado. Se reintenta sola hasta
 *     MAX_ATTEMPTS (`error_retrying`); pasado el tope queda quieta y hay que
 *     reintentarla a mano (`error_stuck`).
 *   · sent / pending → en manos de la DIAN o reclamada por un envío.
 *   · to_send → todavía no salió (cola, o frenada por configuración).
 */
export type InvoiceDianStatus =
  | "accepted"
  | "rejected"
  | "error_retrying"
  | "error_stuck"
  | "in_process"
  | "not_sent";

export function invoiceDianStatus(doc: { state: string; attempts: number }): InvoiceDianStatus {
  switch (doc.state) {
    case "accepted":
      return "accepted";
    case "rejected":
      return "rejected";
    case "error":
      return doc.attempts >= MAX_ATTEMPTS ? "error_stuck" : "error_retrying";
    case "sent":
    case "pending":
      return "in_process";
    default:
      return "not_sent";
  }
}

/** En qué filtro cae cada estado. */
export function invoiceStateBucket(status: InvoiceDianStatus): Exclude<InvoiceStateFilter, "all"> {
  if (status === "accepted") return "accepted";
  if (status === "rejected" || status === "error_stuck") return "rejected";
  return "in_process";
}

/**
 * El mismo reparto, como filtro del DianDocument. "Rechazadas" son las que
 * esperan a una persona: las rechazadas por la DIAN y las que agotaron los
 * reintentos automáticos. Un error de canal que se va a reintentar solo es
 * "en proceso": contarlo como rechazo alarmaría por una caída de la DIAN de
 * diez minutos.
 */
export function dianStateWhere(
  filter: InvoiceStateFilter,
): Prisma.DianDocumentWhereInput | null {
  switch (filter) {
    case "accepted":
      return { state: "accepted" };
    case "rejected":
      return {
        OR: [{ state: "rejected" }, { state: "error", attempts: { gte: MAX_ATTEMPTS } }],
      };
    case "in_process":
      return {
        OR: [
          { state: { in: ["to_send", "sent", "pending"] } },
          { state: "error", attempts: { lt: MAX_ATTEMPTS } },
        ],
      };
    default:
      return null;
  }
}

/** Instantes [gte, lt) del rango de días operativos (corte del comercio). */
export function businessRange(
  from: string | null,
  to: string | null,
  cutoffHour: number,
): { gte?: Date; lt?: Date } | null {
  if (!from && !to) return null;
  return {
    ...(from ? { gte: bogotaDayRange(from, cutoffHour).start } : {}),
    ...(to ? { lt: bogotaDayRange(to, cutoffHour).end } : {}),
  };
}

/**
 * Número de factura como se escribe ("FESM7845" o "7845"): si la búsqueda
 * es eso, el número. Un prefijo de letras se ignora (el prefijo histórico
 * vive en el snapshot y no se filtra por él).
 */
function invoiceNumberQuery(q: string): number | null {
  const m = /^[A-Za-z]{0,10}\s*-?\s*(\d{1,10})$/.exec(q);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 && n <= 2_147_483_647 ? n : null;
}

/**
 * Documento como lo guarda la solicitud: sólo el número, sin puntos,
 * espacios ni dígito de verificación ("900.123.456-7" → "900123456").
 */
function documentQuery(q: string): string | null {
  if (!/\d/.test(q)) return null;
  const base = q.includes("-") ? q.split("-")[0] : q;
  const digits = base.replace(/[.\s]/g, "");
  return digits.length >= 3 ? digits : null;
}

/** OR de la búsqueda libre. */
export function invoiceSearchWhere(q: string): Prisma.SimpleInvoiceWhereInput[] {
  const text = q.trim();
  if (!text) return [];
  const contains = { contains: text, mode: "insensitive" as const };
  const doc = documentQuery(text);
  const number = invoiceNumberQuery(text);
  return [
    ...(number != null ? [{ invoiceNumber: number }] : []),
    { order: { shortCode: contains } },
    { email: contains },
    { order: { simpleInvoiceEmail: contains } },
    {
      order: {
        invoiceRequests: {
          some: {
            OR: [
              { customerName: contains },
              { email: contains },
              { docNumber: { contains: doc ?? text, mode: "insensitive" as const } },
            ],
          },
        },
      },
    },
  ];
}

/**
 * `where` de la lista: facturas del comercio con documento DIAN de tipo
 * `invoice` (las tirillas sin documento —comprobantes de una cortesía, o las
 * de antes de activar el módulo— no son facturas electrónicas), filtradas por
 * estado, rango de días operativos (sobre `SimpleInvoice.createdAt`, el
 * índice [restaurantId, createdAt]) y búsqueda.
 */
export function invoiceListWhere(
  restaurantId: string,
  params: Pick<InvoiceListParams, "state" | "from" | "to" | "q">,
  cutoffHour: number,
): Prisma.SimpleInvoiceWhereInput {
  const state = dianStateWhere(params.state);
  const range = businessRange(params.from, params.to, cutoffHour);
  const search = invoiceSearchWhere(params.q);
  return {
    restaurantId,
    dianDocument: { is: { kind: "invoice", ...(state ?? {}) } },
    ...(range ? { createdAt: range } : {}),
    ...(search.length ? { OR: search } : {}),
  };
}

/** skip/take de la página. */
export function invoicePageWindow(page: number): { skip: number; take: number } {
  return { skip: (Math.max(1, page) - 1) * INVOICE_PAGE_SIZE, take: INVOICE_PAGE_SIZE };
}

export function invoicePageCount(total: number): number {
  return Math.max(1, Math.ceil(total / INVOICE_PAGE_SIZE));
}

/**
 * Los últimos 30 días operativos, hoy incluido: el aviso de rechazadas y
 * el enlace a su filtro usan el mismo rango.
 */
export function last30BusinessDays(cutoffHour: number, now: Date = new Date()): {
  from: string;
  to: string;
} {
  const to = bogotaBusinessDateIso(now, cutoffHour);
  return { from: addDaysIso(to, -29), to };
}

/** "FESM7845" a partir del prefijo congelado en la tirilla. */
export function invoiceDisplayNumber(prefix: string | null | undefined, n: number): string {
  return prefix ? `${prefix}${n}` : String(n);
}
