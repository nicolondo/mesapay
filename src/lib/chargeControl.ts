// Control de caja: "solo el administrador inicia el cobro".
//
// Cuando `Restaurant.adminOnlyCharge = true`, el rol `mesero` NO puede
// iniciar ni cerrar el cobro de una mesa: sólo `operator` /
// `platform_admin`. El comensal sigue pudiendo pagar solo desde su QR —
// lo que se restringe es que un miembro del staff que no sea el dueño
// toque la plata.
//
// Este archivo es PURO a propósito (no importa `@/lib/db`): así los
// tests de vitest — que corren en entorno node sin DATABASE_URL — pueden
// importarlo sin instanciar Prisma. El guard que lee la bandera de la
// base vive en `src/lib/chargeGuard.ts`.

import { resolveShiftPolicy, type ShiftPolicy } from "./staffPolicies";

/**
 * Código de error que devuelven TODAS las rutas de cobro cuando el
 * mesero está bloqueado. El cliente lo traduce (nunca mandamos copy en
 * español desde la API — ver AGENTS.md).
 */
export const CHARGE_ADMIN_ONLY_ERROR = "charge_admin_only" as const;

/** Roles que cuentan como "administrador" para el control de caja. */
const ADMIN_ROLES = new Set(["operator", "platform_admin"]);

/**
 * ¿Este rol puede iniciar un cobro en este comercio?
 *
 * - Con la política apagada: todo sigue como antes (mesero incluido).
 * - Con la política encendida: sólo operator / platform_admin.
 *
 * El rol `terminal` (el cajero del datáfono) NO se bloquea: es la caja
 * misma, no un mesero en el piso. Los comensales llegan sin rol
 * (`undefined`) y tampoco se bloquean — la restricción es sobre el staff.
 */
export function canRoleStartCharge(
  role: string | null | undefined,
  adminOnlyCharge: boolean,
): boolean {
  if (!adminOnlyCharge) return true;
  return role !== "mesero";
}

/** Inverso de `canRoleStartCharge`, que es como lo leen las rutas. */
export function isChargeBlockedForRole(
  role: string | null | undefined,
  adminOnlyCharge: boolean,
): boolean {
  return !canRoleStartCharge(role, adminOnlyCharge);
}

/** ¿El rol es administrador (quien SÍ cobra con la política activa)? */
export function isAdminRole(role: string | null | undefined): boolean {
  return !!role && ADMIN_ROLES.has(role);
}

/**
 * Política de turnos EFECTIVA.
 *
 * Con `adminOnlyCharge` activo el turno queda forzado a "único del
 * local": si la caja la maneja una sola persona, un turno por mesero no
 * tiene contra qué cuadrar (ningún cobro queda atado a un mesero, así
 * que su arqueo personal siempre daría $0).
 *
 * La API de políticas ya persiste "global" al encender la bandera; esto
 * es el cinturón además de los tirantes, para que un dato inconsistente
 * (rollback, edición manual en la base) no reviva los turnos por mesero.
 */
export function effectiveShiftPolicy(
  rawShiftPolicy: string | null | undefined,
  adminOnlyCharge: boolean,
): ShiftPolicy {
  if (adminOnlyCharge) return "global";
  return resolveShiftPolicy(rawShiftPolicy);
}

/**
 * ¿Se puede guardar esta combinación de políticas?
 *
 * `by_waiter` + `adminOnlyCharge` es contradictorio, así que la API lo
 * rechaza en vez de "arreglarlo" en silencio: el dueño tiene que ver por
 * qué su elección no se aplicó.
 */
export function shiftPolicyAllowedWith(
  shiftPolicy: ShiftPolicy,
  adminOnlyCharge: boolean,
): boolean {
  return !(adminOnlyCharge && shiftPolicy === "by_waiter");
}
