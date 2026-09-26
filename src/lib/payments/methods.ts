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
 * cada ruta: qué pendientes son sólo una solicitud del comensal que el
 * staff reemplaza al cobrar (`REPLACEABLE_PENDING_METHODS`).
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
 * ¿Un pago `pending` de este método es sólo una SOLICITUD del comensal que
 * el staff puede reemplazar al cobrar?
 *
 * Un pendiente reserva su parte de la cuenta (el trigger
 * `mesapay_reserve_payment` suma pendientes y aprobados contra lo que falta),
 * así que mientras exista, nadie puede cobrar esa parte por otro lado. Eso
 * está bien cuando hay plata en vuelo en un proveedor —cobrar otra vez
 * podría cobrarle dos veces al comensal—, pero NO cuando el pendiente sólo
 * dice "tráiganme el datáfono" o "voy a pagar en efectivo": ahí no se movió
 * un peso, y si quien cobra decide otra cosa, la solicitud queda obsoleta.
 *
 * `true` = solicitud sin dinero en vuelo: el staff la declina al cobrar.
 * `false` = pago que puede estar en curso en un proveedor (o que ni siquiera
 * nace pendiente): NUNCA se reemplaza; quien cobra tiene que esperar su
 * resultado (o resolverlo en Salón / Pagos). Ante la duda, `false`.
 *
 * Es un `Record` sobre el enum a propósito: un método nuevo en el schema no
 * compila hasta que alguien decida de qué lado queda.
 */
const PENDING_IS_REPLACEABLE_REQUEST: Record<PaymentMethod, boolean> = {
  // "Voy a pagar en efectivo" desde el QR: el mesero recibe los billetes y
  // lo confirma en `settle-cash`. Hasta entonces no entró nada.
  cash: true,
  // Mismo efectivo, con el nombre histórico.
  demo_cash: true,
  // Datáfono PROPIO del comercio: MESAPAY no habla con ningún adquiriente.
  // El pendiente sólo pide que alguien lleve el POS a la mesa; la tarjeta se
  // pasa a mano y el staff reporta el resultado (`settle-external-terminal`).
  // Si el staff cobra por otra vía, es porque no pasó la tarjeta por ahí.
  external_terminal: true,
  // Smart POS de Kushki: en cuanto se empuja al equipo (`terminal/charge`)
  // el cobro está en el adquiriente y su resultado llega después. Un
  // pendiente todavía sin empujar sería sólo una solicitud, pero el método
  // solo no lo distingue: ante la duda, en vuelo.
  kushki_card_terminal: false,
  // Tarjeta tokenizada / billeteras de Kushki: el cargo se hace contra el
  // proveedor; si la respuesta se perdió, el pendiente queda para
  // conciliación. Plata en vuelo.
  kushki_card: false,
  kushki_apple_pay: false,
  kushki_google_pay: false,
  // PSE: el comensal está en la web de su banco; el resultado llega por
  // webhook. Plata en vuelo.
  kushki_pse: false,
  // Rieles de Wompi (históricos): pasarela externa, mismo criterio.
  wompi_card: false,
  wompi_pse: false,
  wompi_nequi: false,
  // Tarjeta demo: nace aprobada (y en producción está bloqueada). Nunca
  // debería estar pendiente; si lo estuviera, no hay por qué tocarla.
  demo_card: false,
  // Abono de reserva, bono y crédito nacen aprobados: son plata que ya entró
  // (o deuda ya reconocida), nunca una solicitud.
  reservation_deposit: false,
  voucher: false,
  customer_credit: false,
};

/**
 * Métodos cuyos pendientes el staff reemplaza (declina) al cobrar la cuenta:
 * `cash`, `demo_cash` y `external_terminal`. Para filtros de Prisma:
 * `method: { in: [...REPLACEABLE_PENDING_METHODS] }`.
 */
export const REPLACEABLE_PENDING_METHODS: readonly PaymentMethod[] = (
  Object.keys(PENDING_IS_REPLACEABLE_REQUEST) as PaymentMethod[]
).filter((m) => PENDING_IS_REPLACEABLE_REQUEST[m]);

/**
 * ¿Un pendiente de este método es una solicitud reemplazable? `false` para
 * cualquier método desconocido: lo que no se sabe clasificar, se respeta.
 */
export function isReplaceablePendingMethod(method: string | null | undefined): boolean {
  return (
    !!method &&
    Object.prototype.hasOwnProperty.call(PENDING_IS_REPLACEABLE_REQUEST, method) &&
    PENDING_IS_REPLACEABLE_REQUEST[method as PaymentMethod]
  );
}
