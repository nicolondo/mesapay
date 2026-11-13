import "server-only";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { HISTORY_KEY_SELECT, historyKeyQueries, historyPage, historyStreams } from "./history";
import { findOrderIdsByDocumentNumber } from "./orderSearchQuery";
import {
  ORDERS_PAGE_SIZE,
  ordersPageCount,
  ordersWhere,
  statusCounts,
  summarizeOrders,
  type OrdersStatusFilter,
  type OrdersSummary,
  type OrdersView,
} from "./ordersView";

/** Lo que cada fila de la lista necesita (el snapshot JSON de la factura no). */
const ROW_INCLUDE = {
  table: true,
  items: { select: { qty: true } },
  payments: {
    where: { status: "approved" },
    // `method`: las cobradas a crédito llevan su distintivo (creditSale.ts).
    select: { amountCents: true, refundedCents: true, method: true },
  },
  simpleInvoice: {
    select: {
      id: true,
      invoiceNumber: true,
      dianDocument: { select: { id: true, state: true } },
    },
  },
} satisfies Prisma.OrderInclude;

export type OrdersListRow = Prisma.OrderGetPayload<{ include: typeof ROW_INCLUDE }> & {
  /** Prefijo congelado en la tirilla de su factura (null si no tiene o no usa). */
  invoicePrefix: string | null;
  /** Es la orden de la factura o nota crédito buscada (va arriba). */
  matchedDocument?: boolean;
};

export type OrdersList = {
  rows: OrdersListRow[];
  /** Totales de TODO lo filtrado (no de la página). */
  summary: OrdersSummary;
  /** Órdenes de cada chip de estado, con el mismo período y búsqueda. */
  counts: Record<OrdersStatusFilter, number>;
  page: number;
  pageCount: number;
  /** `all` = sin filtro de fecha (búsqueda por factura o «todas las fechas»). */
  scope: "period" | "all";
};

/**
 * Una página de la lista de Órdenes y los totales del período.
 *
 * 1. Si lo buscado es un número de factura/nota crédito, sus órdenes.
 * 2. Totales por estado de cada flujo (`groupBy`, por índice) y las claves
 *    de esas órdenes, que van arriba.
 * 3. La página pedida, corregida a la última si no existe (quedó vieja
 *    tras un filtro, o una URL con `page=99999`: las claves se piden hasta
 *    el final de la página, así que primero se acota).
 * 4. Las claves de la página y, sólo de esas filas, los detalles, en el
 *    orden de la lista.
 */
export async function loadOrdersList(
  restaurantId: string,
  view: OrdersView,
  cutoffHour: number,
  pageSize = ORDERS_PAGE_SIZE,
): Promise<OrdersList> {
  const documentOrderIds = view.q ? await findOrderIdsByDocumentNumber(restaurantId, view.q) : [];
  const { countWhere, pinned, rest, range, scope } = ordersWhere(restaurantId, view, cutoffHour, documentOrderIds);

  const keysFor = (page: number) =>
    Promise.all(historyKeyQueries(rest, range, page, pageSize).map((q) => db.order.findMany(q)));
  const [groups, pinnedKeys] = await Promise.all([
    Promise.all(
      historyStreams(countWhere, range).map((streamWhere) =>
        db.order.groupBy({
          by: ["status"],
          where: streamWhere,
          _count: { _all: true },
          _sum: { totalCents: true },
        }),
      ),
    ),
    // Las órdenes de la factura buscada: pocas (≤ 50 por número), arriba.
    pinned ? db.order.findMany({ where: pinned, select: HISTORY_KEY_SELECT }) : Promise.resolve([]),
  ]);
  const summary = summarizeOrders(groups.flat(), view.status);
  const counts = statusCounts(groups.flat());
  const pageCount = ordersPageCount(summary.count, pageSize);
  const page = Math.min(view.page, pageCount);
  const pageKeys = historyPage((await keysFor(page)).flat(), page, pageSize, pinnedKeys);

  const ids = pageKeys.map((k) => k.id);
  const details = ids.length
    ? await db.order.findMany({ where: { restaurantId, id: { in: ids } }, include: ROW_INCLUDE })
    : [];
  const prefixes = await invoicePrefixes(
    restaurantId,
    details.flatMap((o) => (o.simpleInvoice ? [o.simpleInvoice.id] : [])),
  );
  const byId = new Map(details.map((o) => [o.id, o]));
  const rows = ids.flatMap((id) => {
    const row = byId.get(id);
    if (!row) return [];
    const invoicePrefix = row.simpleInvoice ? prefixes.get(row.simpleInvoice.id) ?? null : null;
    return [{ ...row, invoicePrefix }];
  });
  const pinnedIds = new Set(pinnedKeys.map((k) => k.id));
  return { rows: rows.map((r) => ({ ...r, matchedDocument: pinnedIds.has(r.id) })), summary, counts, page, pageCount, scope };
}

/**
 * Prefijo de cada factura de la página, leído del snapshot con una ruta
 * JSON: la tirilla entera (ítems, cliente) no hace falta para el número.
 */
async function invoicePrefixes(restaurantId: string, ids: string[]): Promise<Map<string, string | null>> {
  if (ids.length === 0) return new Map();
  const rows = await db.$queryRaw<{ id: string; prefix: string | null }[]>(Prisma.sql`
    SELECT "id", "snapshot"->>'invoicePrefix' AS "prefix"
      FROM "SimpleInvoice"
     WHERE "restaurantId" = ${restaurantId}
       AND "id" IN (${Prisma.join(ids)})`);
  return new Map(rows.map((r) => [r.id, r.prefix]));
}
