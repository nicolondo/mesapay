/**
 * Estado de la lista de Órdenes (`/operator/orders`) leído de la URL, y la
 * URL de vuelta. Lógica pura: sin DB ni React.
 *
 * ── Parámetros ──────────────────────────────────────────────────────────
 *  · `desde` / `hasta` — días de NEGOCIO (`yyyy-mm-dd`, ambos incluidos), el
 *    mismo par que usan los reportes (`ReportPeriod`). El modo (Día, Semana,
 *    Mes, Rango) no viaja: se deduce de las fechas (`periodKindWithDay`), así
 *    un enlace compartido abre igual. Sin fechas = HOY, y la URL de hoy no
 *    las lleva (la barra de arriba enlaza `?q=` a secas).
 *  · `status` — all | open | paid | cancelled.
 *  · `q` — búsqueda por código de la cuenta o número de factura.
 *  · `source` — all | tables | manual; `tableId` — mesa física concreta.
 *  · `credito=1` — sólo las cuentas cobradas (toda o una parte) a crédito:
 *    un cobro `customer_credit` aprobado (ver `creditSale.ts`).
 *  · `fechas=todas` — sin filtro de fecha (búsqueda global de la barra de
 *    arriba, «Buscar en todas las fechas», enlaces viejos `period=all`).
 *  · `page` — página de 50, desde 1.
 *  · `period` — LEGADO (los chips «Hoy · 7 días · 30 días · Todo»): se
 *    traduce a fechas sólo si no vienen `desde`/`hasta`.
 */
import type { Prisma } from "@prisma/client";
import { addDaysIso, bogotaDayRange } from "@/lib/bogota";
import { isIsoDate, type ReportPeriod } from "@/lib/erp/reports/period";
import type { HistoryRange } from "./history";

export const ORDERS_PAGE_SIZE = 50;

/** El cobro que marca una cuenta «A crédito» (mismo criterio que `creditSale.ts`). */
const CREDIT_SALE_PAYMENT = { method: "customer_credit", status: "approved" } satisfies Prisma.PaymentWhereInput;

export type OrdersStatusFilter = "all" | "open" | "paid" | "cancelled";
export type OrdersSourceFilter = "all" | "tables" | "manual";

export type OrdersView = {
  status: OrdersStatusFilter;
  source: OrdersSourceFilter;
  tableId: string;
  /** Sólo las cuentas cobradas a crédito. */
  credit: boolean;
  q: string;
  period: ReportPeriod;
  /** Sin filtro de fecha. */
  allDates: boolean;
  page: number;
};

type RawParams = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

/** Rango de un período legado (`period=7d`…) contado desde hoy. */
function legacyPeriod(raw: string, today: string): { period: ReportPeriod; allDates: boolean } | null {
  if (raw === "today") return { period: { desde: today, hasta: today }, allDates: false };
  if (raw === "7d") return { period: { desde: addDaysIso(today, -6), hasta: today }, allDates: false };
  if (raw === "30d") return { period: { desde: addDaysIso(today, -29), hasta: today }, allDates: false };
  if (raw === "all") return { period: { desde: today, hasta: today }, allDates: true };
  return null;
}

/**
 * La vista pedida por la URL. Lo inválido se ignora como si no viniera:
 * una sola fecha vale como ese día, `desde > hasta` se da vuelta, una
 * página que no es un entero positivo es la 1.
 */
export function parseOrdersView(sp: RawParams, today: string): OrdersView {
  const rawStatus = first(sp.status);
  const status: OrdersStatusFilter =
    rawStatus === "open" || rawStatus === "paid" || rawStatus === "cancelled" ? rawStatus : "all";
  const q = first(sp.q).trim().slice(0, 100);
  const rawSource = first(sp.source);
  const tableId = rawSource === "manual" ? "" : first(sp.tableId).trim().slice(0, 100);
  const source: OrdersSourceFilter = rawSource === "manual" ? "manual" : rawSource === "tables" || tableId ? "tables" : "all";
  const credit = first(sp.credito) === "1";
  const rawPage = first(sp.page);
  const page = /^\d{1,6}$/.test(rawPage) && Number(rawPage) >= 1 ? Number(rawPage) : 1;

  const desde = first(sp.desde);
  const hasta = first(sp.hasta);
  const from = isIsoDate(desde) ? desde : null;
  const to = isIsoDate(hasta) ? hasta : null;
  let period: ReportPeriod = { desde: today, hasta: today };
  let allDates = first(sp.fechas) === "todas";
  if (from || to) {
    const a = from ?? to!;
    const b = to ?? from!;
    period = a <= b ? { desde: a, hasta: b } : { desde: b, hasta: a };
  } else {
    const legacy = legacyPeriod(first(sp.period), today);
    if (legacy) {
      period = legacy.period;
      allDates = allDates || legacy.allDates;
    }
  }
  return { status, source, tableId, credit, q, period, allDates, page };
}

/**
 * URL de la lista para una vista. Sólo lleva lo que no es el valor por
 * omisión, en un orden fijo (enlaces estables). Todo cambio vuelve a la
 * página 1, salvo que `patch` traiga su propia `page` (la paginación).
 */
export function ordersHref(
  view: OrdersView,
  today: string,
  patch: Partial<OrdersView> = {},
): string {
  const next = { ...view, page: 1, ...patch };
  if (patch.source && patch.source !== "tables") next.tableId = "";
  else if (patch.tableId) next.source = "tables";
  const qs = new URLSearchParams();
  if (!(next.period.desde === today && next.period.hasta === today)) {
    qs.set("desde", next.period.desde);
    qs.set("hasta", next.period.hasta);
  }
  if (next.status !== "all") qs.set("status", next.status);
  if (next.q) qs.set("q", next.q);
  if (next.allDates) qs.set("fechas", "todas");
  if (next.source !== "all") qs.set("source", next.source);
  if (next.source === "tables" && next.tableId) qs.set("tableId", next.tableId);
  if (next.credit) qs.set("credito", "1");
  if (next.page > 1) qs.set("page", String(next.page));
  const s = qs.toString();
  return s ? `/operator/orders?${s}` : "/operator/orders";
}

/**
 * Instantes `[gte, lt)` del período en días de negocio: del corte del
 * primer día al corte del día siguiente al último (Bogotá + corte del
 * comercio, como el Resumen, el Cierre y los reportes de ventas).
 */
export function businessPeriodRange(period: ReportPeriod, cutoffHour: number): { gte: Date; lt: Date } {
  return {
    gte: bogotaDayRange(period.desde, cutoffHour).start,
    lt: bogotaDayRange(period.hasta, cutoffHour).end,
  };
}

/** Estados que cuentan como «Abiertas»: todo lo que sigue en servicio. */
export const OPEN_ORDER_STATUSES = ["open", "placed", "in_kitchen", "ready", "served", "paying"] as const;

/** ¿El estado de una orden entra en el filtro? */
export function statusInFilter(status: string, filter: OrdersStatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "open") return (OPEN_ORDER_STATUSES as readonly string[]).includes(status);
  return status === filter;
}

/** El filtro de estado para Prisma (undefined = todos). */
export function ordersStatusWhere(filter: OrdersStatusFilter): Prisma.OrderWhereInput["status"] {
  if (filter === "open") return { in: [...OPEN_ORDER_STATUSES] };
  if (filter === "paid" || filter === "cancelled") return filter;
  return undefined;
}

/**
 * Filtro de la lista y su alcance de fechas.
 *
 *  · Estado y búsqueda por código (`shortCode` que contenga lo escrito)
 *    van siempre juntos con el período.
 *  · Si lo buscado es el número de una factura o nota crédito del comercio
 *    (`documentOrderIds`, de `findOrderIdsByDocumentNumber`), la búsqueda
 *    pasa a TODAS las fechas —una factura se busca por su número, no por el
 *    día— y trae esas órdenes ARRIBA (`pinned`), y debajo los códigos que
 *    también contengan lo escrito (`rest`, sin repetirlas). Con «7913», la
 *    orden de la factura 7913 no queda enterrada entre las decenas de
 *    códigos largos que contienen esos dígitos.
 *  · `allDates` (búsqueda global, enlaces viejos «Todo») quita la fecha.
 */
export function ordersWhere(
  restaurantId: string,
  view: Pick<OrdersView, "status" | "q" | "period" | "allDates"> & Partial<Pick<OrdersView, "source" | "tableId" | "credit">>,
  cutoffHour: number,
  documentOrderIds: readonly string[] = [],
): {
  /** La lista: período/búsqueda Y estado. */
  where: Prisma.OrderWhereInput;
  /** Los contadores: lo mismo SIN el estado (cada chip cuenta el suyo). */
  countWhere: Prisma.OrderWhereInput;
  /** Órdenes del documento buscado, primero en la lista (null = no hay). */
  pinned: Prisma.OrderWhereInput | null;
  /** El resto de la lista (= `where` sin las de `pinned`). */
  rest: Prisma.OrderWhereInput;
  range: HistoryRange;
  scope: "period" | "all";
} {
  // All branches (including pinned invoice-number matches) use the same
  // source scope. A foreign/nonstandard table ID deliberately matches nothing.
  const sourceScope: Prisma.OrderWhereInput = {
    ...(view.source === "manual"
      ? { table: { restaurantId, kind: "manual" } }
      : view.source === "tables" || view.tableId
        ? { table: { restaurantId, kind: "standard" }, ...(view.tableId ? { tableId: view.tableId } : {}) }
        : {}),
    // «A crédito»: igual en la lista, los contadores y las facturas buscadas.
    ...(view.credit ? { payments: { some: CREDIT_SALE_PAYMENT } } : {}),
  };
  const countWhere: Prisma.OrderWhereInput = { restaurantId, ...sourceScope };
  const byDocument = view.q !== "" && documentOrderIds.length > 0;
  if (view.q) {
    const code = { shortCode: { contains: view.q, mode: "insensitive" as const } };
    if (byDocument) countWhere.OR = [code, { id: { in: [...documentOrderIds] } }];
    else Object.assign(countWhere, code);
  }
  const status = ordersStatusWhere(view.status);
  const all = view.allDates || byDocument;
  const where = status ? { ...countWhere, status } : countWhere;
  const ids = [...documentOrderIds];
  return {
    where,
    countWhere,
    pinned: byDocument ? { restaurantId, ...sourceScope, ...(status ? { status } : {}), id: { in: ids } } : null,
    rest: byDocument
      ? {
          restaurantId,
          ...sourceScope,
          shortCode: { contains: view.q, mode: "insensitive" },
          ...(status ? { status } : {}),
          id: { notIn: ids },
        }
      : where,
    range: all ? null : businessPeriodRange(view.period, cutoffHour),
    scope: all ? "all" : "period",
  };
}

/** Cantidad de páginas (≥ 1) para `total` filas. */
export function ordersPageCount(total: number, pageSize = ORDERS_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/** «Mostrando 51–100 de 312»: primera y última fila (1-based) de la página. */
export function ordersPageBounds(
  page: number,
  total: number,
  pageSize = ORDERS_PAGE_SIZE,
): { from: number; to: number } {
  if (total === 0) return { from: 0, to: 0 };
  const from = (page - 1) * pageSize + 1;
  return { from, to: Math.min(total, page * pageSize) };
}

export type OrdersStatusGroup = {
  status: string;
  _count: { _all: number };
  _sum: { totalCents: number | null };
};

export type OrdersSummary = { count: number; paidCount: number; paidSum: number };

/**
 * Totales del encabezado a partir del `groupBy` por estado de cada flujo
 * (con fecha de cobro y sin ella, disjuntos): cuántas órdenes entran en el
 * filtro de estado, cuántas pagadas y lo cobrado en las pagadas
 * (`totalCents`, con impuestos y propina: «Ventas brutas»). Cubre TODO el
 * período filtrado, no la página que se ve.
 */
export function summarizeOrders(
  groups: readonly OrdersStatusGroup[],
  filter: OrdersStatusFilter = "all",
): OrdersSummary {
  return groups.reduce(
    (acc, g) => {
      if (!statusInFilter(g.status, filter)) return acc;
      acc.count += g._count._all;
      if (g.status === "paid") {
        acc.paidCount += g._count._all;
        acc.paidSum += g._sum.totalCents ?? 0;
      }
      return acc;
    },
    { count: 0, paidCount: 0, paidSum: 0 },
  );
}

/** Cuántas órdenes hay en cada chip de estado (con el mismo período y búsqueda). */
export function statusCounts(groups: readonly OrdersStatusGroup[]): Record<OrdersStatusFilter, number> {
  const counts: Record<OrdersStatusFilter, number> = { all: 0, open: 0, paid: 0, cancelled: 0 };
  for (const g of groups) {
    for (const f of ["all", "open", "paid", "cancelled"] as const) {
      if (statusInFilter(g.status, f)) counts[f] += g._count._all;
    }
  }
  return counts;
}
