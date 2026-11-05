import type { Prisma } from "@prisma/client";

type HistoryOrder = { createdAt: Date; paidAt: Date | null };

/**
 * Cuándo cuenta una orden en el historial: la venta es el cobro final
 * (`paidAt`); lo no pagado —abiertas, canceladas y las pagadas viejas sin
 * fecha de cobro— queda en su apertura (`createdAt`). Ese instante la ubica
 * en un día y la ordena en la lista.
 */
export function historyDate(order: HistoryOrder): Date {
  return order.paidAt ?? order.createdAt;
}

/** `[gte, lt)` del período; null = todas las fechas. */
export type HistoryRange = { gte: Date; lt: Date } | null;

/**
 * Los dos flujos DISJUNTOS del historial: con fecha de cobro (filtrado y
 * ordenado por `paidAt`, índice [restaurantId, paidAt]) y sin ella
 * (por `createdAt`, índice [restaurantId, createdAt]). Juntos son
 * exactamente las órdenes cuyo `historyDate` cae en el rango: una cuenta
 * abierta ayer y cobrada hoy está HOY, aunque su apertura sea de ayer.
 */
export function historyStreams(
  where: Prisma.OrderWhereInput,
  range: HistoryRange,
): [Prisma.OrderWhereInput, Prisma.OrderWhereInput] {
  return [
    { ...where, paidAt: range ? { gte: range.gte, lt: range.lt } : { not: null } },
    { ...where, paidAt: null, ...(range ? { createdAt: { gte: range.gte, lt: range.lt } } : {}) },
  ];
}

export const HISTORY_KEY_SELECT = { id: true, paidAt: true, createdAt: true } as const;

type HistoryKeyQuery = {
  where: Prisma.OrderWhereInput;
  orderBy: Prisma.OrderOrderByWithRelationInput[];
  take: number;
  select: typeof HISTORY_KEY_SELECT;
};

/**
 * Claves (id y fechas, nada más) de las primeras `page × pageSize` filas de
 * cada flujo, en el orden de la lista. Las N primeras del total están
 * siempre entre las N primeras de cada flujo, así que mezclar estas dos
 * tandas y cortar la página da exactamente las filas de esa página — sin
 * tope oculto. El costo crece con la página (claves livianas por índice);
 * los detalles se cargan después sólo para las 50 de la página.
 */
export function historyKeyQueries(
  where: Prisma.OrderWhereInput,
  range: HistoryRange,
  page: number,
  pageSize: number,
): [HistoryKeyQuery, HistoryKeyQuery] {
  const [paid, unpaid] = historyStreams(where, range);
  const take = Math.max(1, page) * pageSize;
  return [
    { where: paid, orderBy: [{ paidAt: "desc" }, { id: "desc" }], take, select: HISTORY_KEY_SELECT },
    { where: unpaid, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take, select: HISTORY_KEY_SELECT },
  ];
}

/**
 * Orden de la lista: más reciente primero y, a igual instante, por id
 * descendente (determinista: la misma fila no salta de página entre una
 * consulta y la siguiente). El id es un cuid (minúsculas y dígitos), así
 * que la comparación por código coincide con el `ORDER BY id DESC` de
 * PostgreSQL de cada flujo.
 */
export function compareHistory(a: HistoryOrder & { id: string }, b: HistoryOrder & { id: string }): number {
  return (
    historyDate(b).getTime() - historyDate(a).getTime() ||
    (b.id < a.id ? -1 : b.id > a.id ? 1 : 0)
  );
}

/**
 * Las filas de la página `page` (1-based) a partir de las claves de los dos
 * flujos. `pinned` (las órdenes de la factura buscada) van antes que todo,
 * también ordenadas por fecha; no deben repetirse en `rows`.
 */
export function historyPage<T extends HistoryOrder & { id: string }>(
  rows: readonly T[],
  page: number,
  pageSize: number,
  pinned: readonly T[] = [],
): T[] {
  const start = (Math.max(1, page) - 1) * pageSize;
  return [...[...pinned].sort(compareHistory), ...[...rows].sort(compareHistory)].slice(start, start + pageSize);
}
