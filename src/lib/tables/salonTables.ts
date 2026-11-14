import type { Prisma } from "@prisma/client";

/**
 * Qué mesas son del SALÓN — las que se dibujan en Mesas y en «Mesas en
 * vivo» del datáfono. Nunca una factura manual (mesa oculta `kind = manual`):
 * el dueño, «no quiero que las facturas manuales queden en la pantalla de
 * Mesas hasta que quede pagada». Una factura manual vive en
 * /operator/facturas-manuales, en Órdenes y, emitida, en Cartera, en
 * cualquier estado (borrador, enviada con link, por cobrar).
 */

/** Las mesas que dibuja Mesas: sólo las físicas (en mostrador, la primera). */
export function floorTablesOf<T extends { kind: string }>(all: readonly T[], counterMode: boolean): T[] {
  const standard = all.filter((t) => t.kind === "standard");
  return counterMode ? standard.slice(0, 1) : standard;
}

/** Facturas manuales con cuenta viva: sólo el número, para el acceso desde Mesas. */
export function pendingManualInvoiceCount(
  all: readonly { kind: string; orders: readonly unknown[] }[],
  isMeseroView: boolean,
): number {
  if (isMeseroView) return 0;
  return all.filter((t) => t.kind === "manual" && t.orders.length > 0).length;
}

/**
 * Mesas de «Mesas en vivo» del datáfono: sin la de recogida (número -1) ni
 * las de facturas manuales (desde -100 hacia abajo y `kind = manual`).
 */
export function terminalTablesWhere(restaurantId: string) {
  return {
    restaurantId,
    number: { gte: 0 },
    kind: { not: "manual" },
  } as const satisfies Prisma.TableWhereInput;
}
