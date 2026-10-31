/**
 * "Resolver cobro": cuando un cobro del datáfono Kushki SÍ se envió al equipo
 * (reclamo `terminal:<id>`) y nunca volvió el resultado, el administrador lo
 * marca a mano como rechazado o aprobado, con evidencia, por la misma
 * conciliación de Cobros (`reconcilePayment`). Ver
 * /api/operator/payments/[id]/resolve-terminal.
 *
 * Archivo sin dependencias de servidor: lo usan la ruta y las pantallas
 * (cuenta regresiva, quién ve el botón, validación del formulario).
 */

/**
 * Cuánto esperar desde que se envió el cobro. El cobro sincrónico del Cloud
 * Terminal corta a unos 90 s; pasados 3 minutos ya no llega respuesta por
 * esa vía y quien tiene el comprobante es el equipo.
 */
export const TERMINAL_RESOLVE_AFTER_MS = 3 * 60_000;

/** Nota de evidencia obligatoria ("el datáfono mostró rechazada"). */
export const TERMINAL_RESOLVE_EVIDENCE_MIN = 10;
export const TERMINAL_RESOLVE_EVIDENCE_MAX = 1000;

/** Número de autorización o voucher, obligatorio al marcar aprobado. */
export const TERMINAL_RESOLVE_AUTH_MIN = 3;
export const TERMINAL_RESOLVE_AUTH_MAX = 60;

/**
 * Sólo el administrador del comercio: operador, administrador de grupo o de
 * plataforma. NUNCA el mesero (ni la caja `terminal`): marcar un cobro con
 * tarjeta como aprobado o rechazado es decidir sobre plata del cliente.
 */
const RESOLVER_ROLES: readonly string[] = ["operator", "platform_admin", "group_admin"];

export function canResolveTerminalCharge(role: string | null | undefined): boolean {
  return !!role && RESOLVER_ROLES.includes(role);
}

/** Desde cuándo (ms epoch) se puede resolver a mano; null si nunca se envió. */
export function terminalResolvableAt(pushedAt: string | Date | null | undefined): number | null {
  if (!pushedAt) return null;
  const t = (pushedAt instanceof Date ? pushedAt : new Date(pushedAt)).getTime();
  return Number.isFinite(t) ? t + TERMINAL_RESOLVE_AFTER_MS : null;
}

/** Clave `providerRef` de una resolución manual: única por pago y con el actor. */
export function manualTerminalRef(userId: string, paymentId: string): string {
  return `manual:${userId}:${paymentId}`;
}
