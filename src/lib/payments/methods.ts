/**
 * Efectivo: qué métodos de pago son billetes en el cajón.
 *
 * `cash` es el método con el que se graba hoy todo cobro en efectivo: el
 * comensal pide pagar en efectivo desde el QR (pago `pending` que el mesero
 * confirma en `settle-cash`) o el mesero/cajero cobra directo (`settleNow`).
 *
 * `demo_cash` es el nombre con el que se grabó ese mismo efectivo hasta que
 * existió `cash` — venía de cuando los pagos eran simulados, pero el
 * efectivo nunca lo fue: en producción son cobros reales. Las filas
 * históricas NO se reescriben, así que en caja, cierre de turno,
 * contabilidad y reportes los dos cuentan como efectivo. Nada debe comparar
 * `=== "demo_cash"` a mano: se pregunta acá.
 *
 * Abajo vive también la otra clasificación que no puede repetirse a mano en
 * cada ruta: qué pendientes son sólo una solicitud que el staff reemplaza al
 * cobrar o cancela (`isReplaceablePending`).
 *
 * Archivo sin dependencias de servidor (sólo tipos) para poder usarlo
 * también desde componentes de cliente.
 */

import type { PaymentMethod } from "@prisma/client";

/** Método con el que se registra un cobro en efectivo nuevo. */
export const CASH_METHOD = "cash" satisfies PaymentMethod;

/**
 * Todos los métodos que son efectivo, incluido el histórico. Para filtros
 * de Prisma: `method: { in: [...CASH_METHODS] }`.
 */
export const CASH_METHODS: readonly PaymentMethod[] = [CASH_METHOD, "demo_cash"];

/** ¿Este método es efectivo físico (`cash` o el histórico `demo_cash`)? */
export function isCashMethod(method: string | null | undefined): boolean {
  return method === CASH_METHOD || method === "demo_cash";
}

/**
 * Método con el que se agrupa en reportes y desgloses: el efectivo
 * histórico (`demo_cash`) cae en la misma fila que `cash`, para que un
 * período con los dos no muestre "Efectivo" dos veces. El resto pasa igual.
 */
export function reportingPaymentMethod<M extends string>(method: M): M | typeof CASH_METHOD {
  return isCashMethod(method) ? CASH_METHOD : method;
}

/**
 * ¿Qué es un pago `pending` de este método? ¿Una SOLICITUD que el staff
 * puede reemplazar al cobrar, o plata que puede estar en vuelo?
 *
 * Un pendiente reserva su parte de la cuenta (el trigger
 * `mesapay_reserve_payment` suma pendientes y aprobados contra lo que falta),
 * así que mientras exista, nadie puede cobrar esa parte por otro lado. Eso
 * está bien cuando hay plata en vuelo en un proveedor —cobrar otra vez
 * podría cobrarle dos veces al comensal—, pero NO cuando el pendiente sólo
 * dice "tráiganme el datáfono" o "voy a pagar en efectivo": ahí no se movió
 * un peso, y si quien cobra decide otra cosa, la solicitud queda obsoleta.
 *
 *   - `request`: solicitud sin dinero en vuelo, siempre. El staff la declina
 *     al cobrar (o la cancela).
 *   - `request_until_pushed`: solicitud MIENTRAS nadie la haya enviado al
 *     proveedor. En cuanto se empuja, es plata en vuelo. El método solo no
 *     alcanza: hay que mirar el pago (ver `isReplaceablePending`).
 *   - `in_flight`: puede estar en curso en un proveedor (o ni siquiera nace
 *     pendiente): NUNCA se reemplaza; quien cobra tiene que esperar su
 *     resultado (o resolverlo en Salón / Pagos). Ante la duda, éste.
 *
 * Es un `Record` sobre el enum a propósito: un método nuevo en el schema no
 * compila hasta que alguien decida de qué lado queda.
 */
type PendingNature = "request" | "request_until_pushed" | "in_flight";

const PENDING_NATURE: Record<PaymentMethod, PendingNature> = {
  // "Voy a pagar en efectivo" desde el QR: el mesero recibe los billetes y
  // lo confirma en `settle-cash`. Hasta entonces no entró nada.
  cash: "request",
  // Mismo efectivo, con el nombre histórico.
  demo_cash: "request",
  // Datáfono PROPIO del comercio: MESAPAY no habla con ningún adquiriente.
  // El pendiente sólo pide que alguien lleve el POS a la mesa; la tarjeta se
  // pasa a mano y el staff reporta el resultado (`settle-external-terminal`).
  // Si el staff cobra por otra vía, es porque no pasó la tarjeta por ahí.
  external_terminal: "request",
  // Smart POS de Kushki: `terminal-request` sólo crea el pendiente ("tráiganme
  // el datáfono"); el cobro llega al adquiriente cuando `terminal/charge` lo
  // empuja al equipo, y ANTES de empujarlo deja el reclamo
  // `FinancialOperation` `terminal:<paymentId>` bajo `lockOrder`. Sin ese
  // reclamo (ni `providerRef`) no salió nada hacia Kushki: es una solicitud.
  // Con él, el resultado puede llegar después: plata en vuelo.
  // (Son y Melona, 2026-10-31: un pendiente así, sin equipo donde empujarlo,
  // dejó la cuenta sin poder cobrarse de ninguna forma.)
  kushki_card_terminal: "request_until_pushed",
  // Tarjeta tokenizada / billeteras de Kushki: el cargo se hace contra el
  // proveedor; si la respuesta se perdió, el pendiente queda para
  // conciliación. Plata en vuelo.
  kushki_card: "in_flight",
  kushki_apple_pay: "in_flight",
  kushki_google_pay: "in_flight",
  // PSE: el comensal está en la web de su banco; el resultado llega por
  // webhook. Plata en vuelo.
  kushki_pse: "in_flight",
  // Rieles de Wompi (históricos): pasarela externa, mismo criterio.
  wompi_card: "in_flight",
  wompi_pse: "in_flight",
  wompi_nequi: "in_flight",
  // Tarjeta demo: nace aprobada (y en producción está bloqueada). Nunca
  // debería estar pendiente; si lo estuviera, no hay por qué tocarla.
  demo_card: "in_flight",
  // Abono de reserva, bono y crédito nacen aprobados: son plata que ya entró
  // (o deuda ya reconocida), nunca una solicitud.
  reservation_deposit: "in_flight",
  voucher: "in_flight",
  customer_credit: "in_flight",
};

function pendingNature(method: string | null | undefined): PendingNature {
  return method && Object.prototype.hasOwnProperty.call(PENDING_NATURE, method)
    ? PENDING_NATURE[method as PaymentMethod]
    : "in_flight";
}

const methodsWith = (nature: PendingNature): readonly PaymentMethod[] =>
  (Object.keys(PENDING_NATURE) as PaymentMethod[]).filter((m) => PENDING_NATURE[m] === nature);

/**
 * Métodos cuyos pendientes son SIEMPRE una solicitud, sin mirar el pago:
 * `cash`, `demo_cash` y `external_terminal`. Para filtros de Prisma:
 * `method: { in: [...REPLACEABLE_PENDING_METHODS] }`. Ojo: no incluye el
 * Smart POS de Kushki, que es solicitud sólo mientras no se empujó (ver
 * `PUSHABLE_REQUEST_METHODS` e `isReplaceablePending`).
 */
export const REPLACEABLE_PENDING_METHODS: readonly PaymentMethod[] = methodsWith("request");

/**
 * Métodos cuyo pendiente es una solicitud hasta que alguien lo empuja al
 * proveedor: hoy, sólo `kushki_card_terminal`.
 */
export const PUSHABLE_REQUEST_METHODS: readonly PaymentMethod[] = methodsWith("request_until_pushed");

/**
 * ¿Un pendiente de este método es una solicitud SÓLO por su método
 * (efectivo, datáfono propio)? `false` para el Smart POS de Kushki (depende
 * del pago: usa `isReplaceablePending`) y para cualquier método desconocido:
 * lo que no se sabe clasificar, se respeta.
 */
export function isReplaceablePendingMethod(method: string | null | undefined): boolean {
  return pendingNature(method) === "request";
}

/**
 * Clave del reclamo que `terminal/charge` deja (bajo `lockOrder`) ANTES de
 * empujar un cobro al Smart POS de Kushki. Su existencia es lo que separa
 * "se pidió el datáfono" de "el cobro ya está en el equipo".
 */
export function terminalClaimKey(paymentId: string): string {
  return `terminal:${paymentId}`;
}

/**
 * ¿ESTE pago pendiente es una solicitud que el staff puede reemplazar (al
 * cobrar de otra forma) o cancelar? La regla por estado real, no sólo por
 * método:
 *
 *   - efectivo / datáfono propio pendientes → sí;
 *   - Smart POS de Kushki pendiente SIN reclamo `terminal:<id>` y sin
 *     `providerRef` → sí: nunca se envió al equipo, no hay plata en vuelo;
 *   - Smart POS de Kushki ya empujado (con reclamo o `providerRef`) → no;
 *   - cualquier otro método, o un pago que no está `pending` → no.
 *
 * `hasTerminalClaim` lo averigua el servidor (ver `terminalClaimedIds` en
 * `pendingRequests.ts`); las pantallas reciben el resultado ya calculado.
 */
export function isReplaceablePending(
  payment: { method: string | null | undefined; status?: string | null; providerRef?: string | null },
  hasTerminalClaim: boolean,
): boolean {
  if (payment.status != null && payment.status !== "pending") return false;
  const nature = pendingNature(payment.method);
  if (nature === "request") return true;
  if (nature === "request_until_pushed") return !hasTerminalClaim && !payment.providerRef;
  return false;
}
