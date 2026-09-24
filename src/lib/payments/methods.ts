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
