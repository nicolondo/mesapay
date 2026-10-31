import type { Prisma } from "@prisma/client";
import { computeOrderTotals } from "@/lib/orderTotals";
import { PUSHABLE_REQUEST_METHODS, REPLACEABLE_PENDING_METHODS, isReplaceablePending } from "./methods";
import { PendingPaymentInFlightError, type PaymentInFlight } from "./paymentInFlight";
import { terminalClaimedIds } from "./pendingRequests";

/**
 * Cobro del STAFF sobre una cuenta que el comensal ya empezó a pagar.
 *
 * El caso que lo motivó (Son y Melona, 2026-09-25): el comensal eligió
 * "datáfono del comercio" desde el QR, lo que deja un Payment
 * `external_terminal` PENDIENTE por el total. El trigger
 * `mesapay_reserve_payment` cuenta ese pendiente como reservado, así que
 * cuando el administrador quiso cobrar la cuenta (en efectivo) el INSERT
 * rebotó con `amount_exceeds_outstanding` y la pantalla sólo dijo
 * "operation_conflict", cuatro veces.
 *
 * Regla (una sola, para todos los caminos del staff):
 *
 *   1. Los pendientes que son sólo una SOLICITUD (efectivo, datáfono propio
 *      y el Smart POS de Kushki que nadie envió todavía al equipo; ver
 *      `isReplaceablePending`) se DECLINAN dentro de la misma transacción,
 *      bajo `lockOrder`, justo antes de crear el pago nuevo. Quien cobra
 *      decidió otra cosa.
 *   2. Los pendientes con plata en vuelo en un proveedor (PSE, tarjeta en
 *      línea, Smart POS de Kushki YA empujado…) NO se tocan. Si su reserva no
 *      deja espacio para el cobro nuevo, se responde 409
 *      `pending_payment_in_flight` con qué pago es y por cuánto, para que la
 *      pantalla diga qué esperar en vez de un conflicto genérico.
 *
 * El caso que agregó el Smart POS a la regla 1 (Son y Melona, 2026-10-31):
 * un `kushki_card_terminal` pendiente que NUNCA se empujó (sin reclamo
 * `terminal:<id>`, en un comercio sin datáfono registrado) bloqueaba la
 * cuenta para siempre con "esperando la confirmación del proveedor".
 *
 * Carrera con `terminal/charge`: los dos toman `lockOrder`. Si el staff
 * declina primero, `terminal/charge` re-lee el pago bajo el lock, lo ve
 * `declined` y no crea el reclamo ni llama a Kushki. Si el reclamo se creó
 * primero, acá se lee (bajo el lock) y el pago cuenta como en vuelo.
 *
 * Todo corre dentro de la transacción del caller y DESPUÉS de `lockOrder`:
 * el trigger vuelve a verificar al insertar, esto sólo ordena la casa antes.
 * No cambia el trigger ni el schema.
 */

export { PENDING_PAYMENT_IN_FLIGHT, PendingPaymentInFlightError, type PaymentInFlight } from "./paymentInFlight";

// Mismo peso de holgura que el trigger (`… + 1`) y que
// `validateNewPaymentAmount`: redondeos de "partes iguales".
const SLACK_CENTS = 1;

type Tx = Prisma.TransactionClient;

/** Lo que la pantalla necesita para nombrar un pago en vuelo. */
export function toPaymentInFlight(p: {
  id: string;
  method: PaymentInFlight["method"];
  amountCents: number;
  tipCents: number;
  createdAt: Date;
}): PaymentInFlight {
  return {
    paymentId: p.id,
    method: p.method,
    amountCents: p.amountCents,
    tipCents: p.tipCents,
    createdAt: p.createdAt.toISOString(),
  };
}

/**
 * Los Smart POS de Kushki pendientes de la cuenta que nadie empujó al equipo
 * (sin reclamo `terminal:<id>` ni `providerRef`): solicitudes, aunque su
 * método no esté en `REPLACEABLE_PENDING_METHODS`. Sólo bajo `lockOrder`.
 */
async function unpushedTerminalRequestIds(tx: Tx, orderId: string): Promise<string[]> {
  const rows = await tx.payment.findMany({
    where: { orderId, status: "pending", method: { in: [...PUSHABLE_REQUEST_METHODS] } },
    select: { id: true, method: true, status: true, providerRef: true },
  });
  const candidates = rows.filter((r) => (PUSHABLE_REQUEST_METHODS as readonly string[]).includes(r.method));
  const claimed = await terminalClaimedIds(tx, candidates);
  return candidates.filter((r) => isReplaceablePending(r, claimed.has(r.id))).map((r) => r.id);
}

/**
 * Declina las solicitudes pendientes POR MÉTODO (efectivo, datáfono propio;
 * `REPLACEABLE_PENDING_METHODS`). Devuelve cuántas. No toca el Smart POS de
 * Kushki: para el cobro del staff usa `releaseStaffPaymentRequests`, que
 * además declina el que nadie envió al equipo. (Lo usa, tal cual, la
 * eliminación de comercios, que trata cualquier datáfono Kushki pendiente
 * como en vuelo.) Sólo bajo `lockOrder`.
 */
export async function releasePaymentRequests(tx: Tx, orderId: string): Promise<number> {
  const { count } = await tx.payment.updateMany({
    where: { orderId, method: { in: [...REPLACEABLE_PENDING_METHODS] }, status: "pending" },
    data: { status: "declined" },
  });
  return count;
}

/**
 * Declina TODAS las solicitudes pendientes que reemplaza el cobro del staff:
 * efectivo, datáfono propio y el Smart POS de Kushki que nadie envió al
 * equipo (sin reclamo `terminal:<id>` ni providerRef). Devuelve cuántas.
 * Sólo bajo `lockOrder`, dentro del cobro.
 */
export async function releaseStaffPaymentRequests(tx: Tx, orderId: string): Promise<number> {
  const count = await releasePaymentRequests(tx, orderId);
  const unpushed = await unpushedTerminalRequestIds(tx, orderId);
  if (unpushed.length === 0) return count;
  const terminal = await tx.payment.updateMany({
    where: { id: { in: unpushed }, status: "pending" },
    // Nunca tuvo plata en vuelo: si el barrido la había marcado para
    // conciliación, al declinarla queda resuelta.
    data: { status: "declined", reconciliationRequired: false },
  });
  return count + terminal.count;
}

/** El pendiente EN VUELO más viejo de la cuenta (no una solicitud), o null. */
export async function findPaymentInFlight(tx: Tx, orderId: string): Promise<PaymentInFlight | null> {
  const unpushed = await unpushedTerminalRequestIds(tx, orderId);
  const p = await tx.payment.findFirst({
    where: {
      orderId,
      status: "pending",
      method: { notIn: [...REPLACEABLE_PENDING_METHODS] },
      ...(unpushed.length ? { id: { notIn: unpushed } } : {}),
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, method: true, amountCents: true, tipCents: true, createdAt: true },
  });
  return p ? toPaymentInFlight(p) : null;
}

/**
 * Lo que falta cobrar para el staff: la cuenta menos lo aprobado y menos lo
 * que reservan los pendientes EN VUELO. Las solicitudes no cuentan porque
 * el cobro del staff las reemplaza. También devuelve lo que faltaría sin los
 * pendientes en vuelo, para saber si son ellos los que estorban.
 */
export async function staffOutstanding(
  tx: Tx,
  orderId: string,
): Promise<{ outstandingCents: number; outstandingIgnoringInFlightCents: number; closed: boolean }> {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: { subtotalCents: true, taxCents: true, discountCents: true, status: true },
  });
  if (!order || order.status === "paid" || order.status === "cancelled") {
    return { outstandingCents: 0, outstandingIgnoringInFlightCents: 0, closed: true };
  }
  const rows = await tx.payment.findMany({
    where: {
      orderId,
      OR: [
        { status: "approved" },
        { status: "pending", method: { notIn: [...REPLACEABLE_PENDING_METHODS] } },
      ],
    },
    select: { id: true, amountCents: true, tipCents: true, status: true },
  });
  const unpushed = new Set(await unpushedTerminalRequestIds(tx, orderId));
  const claims = rows.filter((c) => !unpushed.has(c.id));
  const approved = claims.filter((c) => c.status === "approved");
  return {
    outstandingCents: computeOrderTotals(order.subtotalCents, claims, order.taxCents, order.discountCents)
      .outstandingCents,
    outstandingIgnoringInFlightCents: computeOrderTotals(
      order.subtotalCents,
      approved,
      order.taxCents,
      order.discountCents,
    ).outstandingCents,
    closed: false,
  };
}

/**
 * Deja la cuenta lista para que el staff cree un pago de `newFoodCents` de
 * comida (sin propina):
 *
 *   - si no entra SÓLO por un pendiente en vuelo → lanza
 *     `PendingPaymentInFlightError` (la transacción se revierte, no se
 *     declina nada);
 *   - si entra → declina las solicitudes (del comensal o del propio staff,
 *     como un Smart POS que nadie empujó).
 *
 * Si no entra por otra razón (la pantalla quedó vieja y ya se cobró algo),
 * no lanza: el trigger lo rechaza al insertar como hasta ahora.
 */
export async function prepareStaffCharge(
  tx: Tx,
  orderId: string,
  newFoodCents: number,
): Promise<{ declinedRequests: number }> {
  const { outstandingCents, outstandingIgnoringInFlightCents } = await staffOutstanding(tx, orderId);
  const fits = newFoodCents <= outstandingCents + SLACK_CENTS;
  if (!fits && newFoodCents <= outstandingIgnoringInFlightCents + SLACK_CENTS) {
    const inFlight = await findPaymentInFlight(tx, orderId);
    if (inFlight) throw new PendingPaymentInFlightError(inFlight);
  }
  return { declinedRequests: await releaseStaffPaymentRequests(tx, orderId) };
}

/**
 * Para los cobros que se llevan "todo lo pendiente" (crédito, bono,
 * cortesía): si no queda nada por cobrar pero es porque un pago en vuelo lo
 * reserva, lanza el error accionable en vez de "nada pendiente".
 */
export async function assertNoPaymentInFlightHolding(tx: Tx, orderId: string): Promise<void> {
  const inFlight = await findPaymentInFlight(tx, orderId);
  if (inFlight) throw new PendingPaymentInFlightError(inFlight);
}
