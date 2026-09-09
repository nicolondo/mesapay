/**
 * Interruptor de los métodos de pago "demo".
 *
 * PORQUÉ EXISTE ESTE ARCHIVO
 * --------------------------
 * `demo_card` y `demo_nequi` no consultan ninguna pasarela: la ruta crea
 * el Payment en `approved` con `settledAt` puesto y el pedido queda
 * pagado. Sirven para desarrollar sin cobrar plata de verdad, pero en
 * producción son un agujero: la ruta pública `/api/tenant/[slug]/pay` la
 * usa el comensal desde su celular con el `orderId` que ya tiene en la
 * URL, sin sesión y sin adivinar nada. Un POST con `method: "demo_card"`
 * cerraba la cuenta sin que entrara un peso. Lo mismo en
 * `/api/tenant/[slug]/pickup/orders`, que además regala la comida (crea
 * la orden en `paid` y la manda a cocina).
 *
 * OJO — `demo_cash` NO entra acá. A pesar del prefijo, es el método con
 * el que se registra el EFECTIVO de verdad: el comensal llama al mesero
 * (pago `pending`) o el mesero cobra con sesión verificada (`settleNow`
 * + rol operator/mesero/platform_admin). Bloquearlo en producción
 * dejaría al restaurante sin poder cobrar en efectivo, que es peor que
 * el bug que estamos cerrando.
 *
 * POR QUÉ UNA VARIABLE EXPLÍCITA Y NO SÓLO `NODE_ENV`
 * ---------------------------------------------------
 * 1. `NODE_ENV` lo pone la herramienta de build, no quien despliega:
 *    cualquier `next build && next start` queda en "production". Es un
 *    efecto secundario del build, no una decisión de seguridad.
 * 2. Un staging real corre con `NODE_ENV=production` y ahí SÍ queremos
 *    poder probar el flujo de pago sin cobrar. Con un gate atado sólo a
 *    `NODE_ENV` no habría forma, salvo dejar de buildear como producción.
 * 3. Una env var explícita es auditable: se lee el `.env` del server y se
 *    responde "sí/no" sin tener que leer código.
 *
 * El default es DENEGAR en producción: el VPS no necesita cambiar nada
 * para quedar protegido, y quien quiera demos en un ambiente
 * production-like tiene que pedirlo a mano.
 */

import { env } from "./env";

/**
 * Métodos que se auto-aprueban sin pasarela y sin sesión. Son los que el
 * gate apaga fuera de desarrollo.
 */
export const DEMO_AUTO_APPROVE_METHODS = ["demo_card", "demo_nequi"] as const;

export type DemoAutoApproveMethod = (typeof DEMO_AUTO_APPROVE_METHODS)[number];

/** Código de error que devuelven las rutas cuando el gate rechaza. */
export const DEMO_PAYMENTS_DISABLED = "demo_payments_disabled";

export function isDemoAutoApproveMethod(
  method: string,
): method is DemoAutoApproveMethod {
  return (DEMO_AUTO_APPROVE_METHODS as readonly string[]).includes(method);
}

/**
 * ¿Se pueden crear pagos aprobados sin pasarela en este ambiente?
 *
 * - `MESAPAY_ALLOW_DEMO_PAYMENTS` con valor → manda ella, y falla
 *   cerrada: sólo "true"/"1" prenden los demo; un typo los deja
 *   apagados en vez de tumbar el boot o abrir el agujero.
 * - Vacía o sin setear → sí en development/test, NO en production.
 */
export function demoPaymentsAllowed(): boolean {
  const explicit = env.MESAPAY_ALLOW_DEMO_PAYMENTS?.trim().toLowerCase();
  if (!explicit) return env.NODE_ENV !== "production";
  return explicit === "true" || explicit === "1";
}

/**
 * Guard para las rutas: `true` si hay que rechazar el request. Se llama
 * ANTES de tocar la DB — un pago demo bloqueado no debe dejar ni una
 * escritura ni un rastro parcial.
 */
export function shouldBlockDemoPayment(method: string): boolean {
  return isDemoAutoApproveMethod(method) && !demoPaymentsAllowed();
}
