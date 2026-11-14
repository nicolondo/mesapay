// Lista de Compras (/operator/compras): filtros de la URL, búsqueda,
// estado de pago, orden, paginación y el resumen. PURO —sin DB— para
// probarlo sin base; la consulta vive en `purchaseListQueries.ts`.
//
// ── Por qué existe ────────────────────────────────────────────────────────
// Antes la pantalla traía las compras de a 20 («Cargar más») y el «Total por
// pagar» sumaba sólo lo que ya se había cargado: con un proveedor o un
// estado no se podía saber cuánto se le debía. Ahora la búsqueda, los
// filtros y el resumen corren en el servidor sobre TODAS las compras que
// cumplen los filtros, y la lista se pagina.
import { foldSearchText, taxIdKeys } from "@/lib/suppliers/supplierSearch";
import { normalizeDocumentNumber } from "@/lib/erp/documentNumber";

export const PURCHASES_PATH = "/operator/compras";
/** Compras por página. */
export const PURCHASE_PAGE_SIZE = 25;
/** Largo máximo de la búsqueda. */
export const PURCHASE_QUERY_MAX = 80;

/** Pestañas: todas las órdenes, o sólo las cuentas por pagar. */
export type PurchaseTab = "orders" | "unpaid";
export const PURCHASE_TABS: readonly PurchaseTab[] = ["orders", "unpaid"];

export type PoStatus = "draft" | "sent" | "partially_received" | "received" | "canceled";
export const PO_STATUSES: readonly PoStatus[] = ["draft", "sent", "partially_received", "received", "canceled"];

/** Estado de pago de una compra recibida (por abonos y vencimiento). */
export type PayStatus = "paid" | "partial" | "overdue" | "pending";

/**
 * Estado elegido en el filtro. En «Órdenes»: el de la orden, o «Pagada».
 * En «Por pagar»: vencidas, con abonos o sin abonos.
 */
export type PurchaseStatusFilter = "all" | PoStatus | "paid" | "overdue" | "partial" | "pending";
export const ORDER_STATUS_FILTERS: readonly PurchaseStatusFilter[] = ["all", ...PO_STATUSES, "paid"];
export const UNPAID_STATUS_FILTERS: readonly PurchaseStatusFilter[] = ["all", "overdue", "partial", "pending"];

export function statusFiltersFor(tab: PurchaseTab): readonly PurchaseStatusFilter[] {
  return tab === "unpaid" ? UNPAID_STATUS_FILTERS : ORDER_STATUS_FILTERS;
}

export type PurchaseListParams = {
  tab: PurchaseTab;
  /** Búsqueda libre: número de factura u OC, proveedor o NIT. */
  q: string;
  /** Id del proveedor ("" = todos). */
  supplier: string;
  status: PurchaseStatusFilter;
  /** Rango de fechas de la compra, YYYY-MM-DD ("" = abierto). */
  from: string;
  to: string;
  /** 1-based. */
  page: number;
};

export const DEFAULT_PURCHASE_LIST_PARAMS: PurchaseListParams = {
  tab: "orders",
  q: "",
  supplier: "",
  status: "all",
  from: "",
  to: "",
  page: 1,
};

type RawParams = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

function isIsoDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** Página 1-based válida; cualquier otra cosa cae a 1. */
function parsePage(raw: string | string[] | undefined): number {
  const n = Number(first(raw));
  return Number.isSafeInteger(n) && n >= 1 && n <= 100_000 ? n : 1;
}

/**
 * Lee los filtros de la URL. Lo que no se entiende cae al valor por defecto:
 * una URL vieja o editada a mano nunca rompe la pantalla. Un rango al revés
 * se endereza.
 */
export function parsePurchaseListParams(sp: RawParams): PurchaseListParams {
  const tab: PurchaseTab = first(sp.tab) === "unpaid" ? "unpaid" : "orders";
  const rawStatus = first(sp.status);
  const status = (statusFiltersFor(tab) as readonly string[]).includes(rawStatus)
    ? (rawStatus as PurchaseStatusFilter)
    : "all";
  const supplier = first(sp.supplier);
  let from = first(sp.from);
  let to = first(sp.to);
  if (!isIsoDate(from)) from = "";
  if (!isIsoDate(to)) to = "";
  if (from && to && from > to) [from, to] = [to, from];
  return {
    tab,
    q: first(sp.q).trim().slice(0, PURCHASE_QUERY_MAX),
    supplier: /^[a-z0-9]{10,40}$/i.test(supplier) ? supplier : "",
    status,
    from,
    to,
    page: parsePage(sp.page),
  };
}

/** Query string de los filtros, sin los valores por defecto. */
export function purchaseListQuery(params: Partial<PurchaseListParams>): string {
  const qs = new URLSearchParams();
  if (params.tab === "unpaid") qs.set("tab", "unpaid");
  if (params.q) qs.set("q", params.q);
  if (params.supplier) qs.set("supplier", params.supplier);
  if (params.status && params.status !== "all") qs.set("status", params.status);
  if (params.from) qs.set("from", params.from);
  if (params.to) qs.set("to", params.to);
  if (params.page && params.page > 1) qs.set("page", String(params.page));
  return qs.toString();
}

export function purchaseListHref(params: Partial<PurchaseListParams>): string {
  const qs = purchaseListQuery(params);
  return qs ? `${PURCHASES_PATH}?${qs}` : PURCHASES_PATH;
}

/** ¿Hay algo que acote la lista (para "Limpiar filtros", el vacío y el resumen)? */
export function hasPurchaseFilters(
  params: Pick<PurchaseListParams, "q" | "supplier" | "status" | "from" | "to">,
): boolean {
  return params.q !== "" || params.supplier !== "" || params.status !== "all" || params.from !== "" || params.to !== "";
}

/** Los filtros de la pestaña, sin estado ni página: lo que se conserva al cambiar de pestaña. */
export function tabHref(params: PurchaseListParams, tab: PurchaseTab): string {
  return purchaseListHref({ ...params, tab, status: "all", page: 1 });
}

// ── Búsqueda ────────────────────────────────────────────────────────────

export type PurchaseSearch = {
  /** Lo escrito, sin tildes ni mayúsculas (proveedor). */
  text: string;
  /** Clave de factura (`normalizeDocumentNumber`) o null. */
  invoiceKey: string | null;
  /** Consecutivo de la compra si lo escrito lo parece ("OC-0012", "12"). */
  poNumber: number | null;
  /** Dígitos de lo escrito si parece un NIT (6 o más). */
  taxDigits: string | null;
};

export function parsePurchaseSearch(q: string): PurchaseSearch | null {
  const trimmed = q.trim();
  if (!trimmed) return null;
  const oc = /^(?:oc\s*-?\s*)?0*(\d{1,9})$/i.exec(trimmed);
  const digits = trimmed.replace(/\D/g, "");
  return {
    text: foldSearchText(trimmed),
    invoiceKey: normalizeDocumentNumber(trimmed),
    poNumber: oc ? Number(oc[1]) : null,
    taxDigits: /^[\d.\-\s]+$/.test(trimmed) && digits.length >= 6 ? digits : null,
  };
}

export type SearchablePurchase = {
  number: number;
  supplierInvoiceNumber: string | null;
  supplierName: string;
  supplierTaxId: string | null;
};

/**
 * ¿La compra coincide con la búsqueda? Por número de factura (contiene,
 * normalizado: «123» encuentra «FE-000123»), por consecutivo de la orden
 * («OC-12» o «12»), por nombre del proveedor (sin tildes) o por su NIT.
 */
export function matchesPurchaseSearch(p: SearchablePurchase, s: PurchaseSearch | null): boolean {
  if (!s) return true;
  if (s.poNumber !== null && p.number === s.poNumber) return true;
  if (s.invoiceKey) {
    const key = normalizeDocumentNumber(p.supplierInvoiceNumber);
    if (key && key.includes(s.invoiceKey)) return true;
  }
  if (s.text && foldSearchText(p.supplierName).includes(s.text)) return true;
  if (s.taxDigits && taxIdKeys(p.supplierTaxId).some((k) => k.includes(s.taxDigits!))) return true;
  return false;
}

// ── Estado de pago y resumen ────────────────────────────────────────────

/** Compra que ya es una cuenta por pagar (recibida, aunque sea en parte). */
export function isPayable(status: PoStatus): boolean {
  return status === "received" || status === "partially_received";
}

/**
 * Estado de pago (null si la compra no se ha recibido o está anulada).
 * Vencida = la fecha de vencimiento (día en Bogotá) ya pasó.
 */
export function payStatusOf(
  p: { status: PoStatus; outstandingCents: number; paidCents: number; dueDate: string | null },
  todayIso: string,
): PayStatus | null {
  if (!isPayable(p.status)) return null;
  if (p.outstandingCents <= 0) return "paid";
  if (p.dueDate && p.dueDate < todayIso) return "overdue";
  if (p.paidCents > 0) return "partial";
  return "pending";
}

/** ¿La compra cae en el filtro de estado de la pestaña? */
export function matchesStatusFilter(
  p: { status: PoStatus; payStatus: PayStatus | null },
  tab: PurchaseTab,
  status: PurchaseStatusFilter,
): boolean {
  if (tab === "unpaid") {
    const owed = p.payStatus !== null && p.payStatus !== "paid";
    if (!owed) return false;
    return status === "all" || p.payStatus === status;
  }
  if (status === "all") return true;
  if (status === "paid") return p.payStatus === "paid";
  return p.status === status;
}

export type PurchaseListSummary = {
  /** Compras que cumplen los filtros. */
  count: number;
  /** Suma del total de cada una (lo que muestra la lista), sin anuladas. */
  totalCents: number;
  /** Saldo por pagar de las que cumplen los filtros. */
  payableCents: number;
  payableCount: number;
  /** De ese saldo, lo vencido. */
  overdueCents: number;
  overdueCount: number;
};

export type SummarizablePurchase = {
  status: PoStatus;
  /** Total que muestra la lista para esta compra. */
  totalCents: number;
  outstandingCents: number;
  payStatus: PayStatus | null;
};

export function summarizePurchases(rows: readonly SummarizablePurchase[]): PurchaseListSummary {
  const s: PurchaseListSummary = {
    count: rows.length,
    totalCents: 0,
    payableCents: 0,
    payableCount: 0,
    overdueCents: 0,
    overdueCount: 0,
  };
  for (const r of rows) {
    if (r.status !== "canceled") s.totalCents += r.totalCents;
    if (r.payStatus && r.payStatus !== "paid" && r.outstandingCents > 0) {
      s.payableCents += r.outstandingCents;
      s.payableCount += 1;
      if (r.payStatus === "overdue") {
        s.overdueCents += r.outstandingCents;
        s.overdueCount += 1;
      }
    }
  }
  return s;
}

/** Una compra de la lista, ya calculada (sin líneas: no viajan al navegador). */
export type PurchaseListRow = {
  id: string;
  number: number;
  status: PoStatus;
  createdAt: string;
  supplier: { id: string; name: string };
  supplierInvoiceNumber: string | null;
  invoiceDueAt: string | null;
  itemCount: number;
  /** Total de la orden (lo pedido, con impuestos y retenciones). */
  orderTotalCents: number;
  /** Total recibido (la cuenta por pagar). */
  receivedTotalCents: number;
  /** Retenciones de lo recibido. */
  receivedRetentionsCents: number;
  paidCents: number;
  /** Saldo por pagar (0 si no se ha recibido o ya se pagó). */
  outstandingCents: number;
  payStatus: PayStatus | null;
};

export type PurchaseListPage = {
  rows: PurchaseListRow[];
  page: number;
  pageCount: number;
  from: number;
  to: number;
  total: number;
  summary: PurchaseListSummary;
};

/** Ventana de la página pedida (se ajusta si quedó fuera de rango). */
export function pageWindow(page: number, total: number, pageSize = PURCHASE_PAGE_SIZE) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, page), pageCount);
  const start = (current - 1) * pageSize;
  return {
    page: current,
    pageCount,
    start,
    end: Math.min(start + pageSize, total),
    from: total === 0 ? 0 : start + 1,
    to: Math.min(start + pageSize, total),
  };
}
