import type { Prisma } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { shortCode } from "@/lib/shortCode";

/**
 * FACTURA MANUAL — una orden que no vive en ninguna mesa física.
 *
 * El dueño la pidió así: "una mesa que en realidad no sea una mesa, sino una
 * opción para crear facturas manualmente, con platos o cargos". Todo lo que
 * hace falta (agregar platos, líneas libres, descuento, identificar al
 * cliente, cobrar, tirilla y factura electrónica) ya existe sobre una
 * `Order`, y una `Order` exige una `Table`. Así que la factura manual ES una
 * orden sobre una mesa oculta de `kind = manual`.
 *
 *   - Una fila por factura ABIERTA: pueden convivir varias a la vez. Cuando
 *     una se cobra (o se descarta), su mesa queda libre y la próxima factura
 *     la reutiliza en vez de crear otra.
 *   - Número negativo desde -100 hacia abajo (`min(number) - 1` por
 *     comercio). Negativo para que todos los guards `number < 0` (push a
 *     meseros, llamadas, reservas, QR de invitado…) la excluyan sin tocarlos;
 *     desde -100 para no rozar nunca a la de recogida (-1).
 *   - Sus platos NO van a cocina: nacen servidos, como una línea libre (ver
 *     /api/tenant/[slug]/orders). Es un documento, no un pedido a preparar.
 */

export const MANUAL_TABLE_FIRST_NUMBER = -100;

/** Rótulo de la fila. Es contenido de DB (como "Pickup"), no un catálogo. */
export const MANUAL_TABLE_LABEL = "Factura manual";

/** Una orden que todavía ocupa su mesa: ni cobrada ni descartada. */
export const OPEN_ORDER_STATUS_FILTER = {
  status: { notIn: ["paid", "cancelled"] },
} as const satisfies Prisma.OrderWhereInput;

/**
 * Próximo número para una mesa manual nueva dado TODOS los números del
 * comercio (no sólo los manuales: la unique es por comercio y número).
 * Empieza en -100 y baja de a uno; nunca cae en -1 ni en 0.
 */
export function nextManualTableNumber(existingNumbers: readonly number[]): number {
  const lowest = existingNumbers.length > 0 ? Math.min(...existingNumbers) : 0;
  return Math.min(MANUAL_TABLE_FIRST_NUMBER, lowest - 1);
}

/**
 * Serializa a quienes abren facturas manuales del mismo comercio: dos
 * operadores tocando "Factura manual" al mismo tiempo no deben compartir la
 * misma mesa libre ni calcular el mismo número (la unique lo rebotaría).
 * Mismo mecanismo que `lockStock`, con otra clave.
 */
export async function lockManualInvoices(
  tx: Prisma.TransactionClient,
  restaurantId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${restaurantId}), 733)`;
}

export type OpenedManualInvoice = {
  orderId: string;
  shortCode: string;
  tableId: string;
  tableNumber: number;
  /** true si hubo que crear una mesa manual nueva (ninguna estaba libre). */
  createdTable: boolean;
};

/**
 * Abre una factura manual: reutiliza una mesa manual del comercio sin orden
 * abierta o crea una nueva, y deja sobre ella una `Order` vacía en `open`.
 * Los platos y cargos entran después por los caminos de siempre.
 */
export async function openManualInvoiceInTx(
  tx: Prisma.TransactionClient,
  args: { restaurantId: string; locale: string | null },
): Promise<OpenedManualInvoice> {
  await lockManualInvoices(tx, args.restaurantId);

  // La más "alta" (-100 antes que -101) para que el pool no crezca por
  // el fondo cuando la de arriba ya se liberó.
  const free = await tx.table.findFirst({
    where: {
      restaurantId: args.restaurantId,
      kind: "manual",
      orders: { none: OPEN_ORDER_STATUS_FILTER },
    },
    orderBy: { number: "desc" },
    select: { id: true, number: true },
  });

  let table = free;
  if (!table) {
    const all = await tx.table.findMany({
      where: { restaurantId: args.restaurantId },
      select: { number: true },
    });
    table = await tx.table.create({
      data: {
        restaurantId: args.restaurantId,
        number: nextManualTableNumber(all.map((t) => t.number)),
        kind: "manual",
        label: MANUAL_TABLE_LABEL,
        qrToken: randomBytes(16).toString("hex"),
        // Nunca aparece en el plano ni acepta reservas — no es un lugar.
        reservable: false,
      },
      select: { id: true, number: true },
    });
  }

  const order = await tx.order.create({
    data: {
      restaurantId: args.restaurantId,
      tableId: table.id,
      status: "open",
      shortCode: shortCode(),
      servingMode: "asReady",
      locale: args.locale,
    },
    select: { id: true, shortCode: true },
  });

  return {
    orderId: order.id,
    shortCode: order.shortCode,
    tableId: table.id,
    tableNumber: table.number,
    createdTable: !free,
  };
}
