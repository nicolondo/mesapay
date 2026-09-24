// Políticas que un comercio puede configurar para definir cómo se
// reparten propinas y cómo se cuentan los turnos del staff.
//
// Modelo: `Restaurant.tipPolicy` y `Restaurant.shiftPolicy` son strings
// libres con default histórico. No usamos enums Prisma para evitar
// migraciones cada vez que sumamos un valor nuevo; resolvemos siempre
// vía las constantes de abajo y caemos al default si llegara un valor
// desconocido (back-compat ante rollback).

export const TIP_POLICIES = ["shared", "by_waiter"] as const;
export type TipPolicy = (typeof TIP_POLICIES)[number];
export const DEFAULT_TIP_POLICY: TipPolicy = "shared";

export const SHIFT_POLICIES = ["global", "by_waiter"] as const;
export type ShiftPolicy = (typeof SHIFT_POLICIES)[number];
export const DEFAULT_SHIFT_POLICY: ShiftPolicy = "global";

// Qué pasa cuando un mesero intenta abrir su turno y el local todavía no
// abrió el turno general (solo aplica a shiftPolicy="by_waiter"):
//   - "block":     no lo dejamos; pedimos que el operador abra primero.
//   - "auto_open": abrimos el turno del local automáticamente con la misma
//                  base que declara el mesero (luego se editan desde caja).
export const MESERO_SHIFT_WITHOUT_LOCAL = ["block", "auto_open"] as const;
export type MeseroShiftWithoutLocal =
  (typeof MESERO_SHIFT_WITHOUT_LOCAL)[number];
export const DEFAULT_MESERO_SHIFT_WITHOUT_LOCAL: MeseroShiftWithoutLocal =
  "block";

export function resolveMeseroShiftWithoutLocal(
  raw: string | null | undefined,
): MeseroShiftWithoutLocal {
  if (raw && (MESERO_SHIFT_WITHOUT_LOCAL as readonly string[]).includes(raw)) {
    return raw as MeseroShiftWithoutLocal;
  }
  return DEFAULT_MESERO_SHIFT_WITHOUT_LOCAL;
}

export function resolveTipPolicy(raw: string | null | undefined): TipPolicy {
  if (raw && (TIP_POLICIES as readonly string[]).includes(raw)) {
    return raw as TipPolicy;
  }
  return DEFAULT_TIP_POLICY;
}

export function resolveShiftPolicy(
  raw: string | null | undefined,
): ShiftPolicy {
  if (raw && (SHIFT_POLICIES as readonly string[]).includes(raw)) {
    return raw as ShiftPolicy;
  }
  return DEFAULT_SHIFT_POLICY;
}

/**
 * Cuando el mesero abre su tab "Yo" queremos saber si tiene sentido
 * mostrarle propinas acumuladas. Solo aplica si el comercio dice
 * `by_waiter` — en `shared` las propinas son del local y la cifra
 * personal es engañosa.
 */
export function tipsAreIndividual(raw: string | null | undefined): boolean {
  return resolveTipPolicy(raw) === "by_waiter";
}

/**
 * Análogo para turnos personales. En `global` el único turno relevante
 * es el del restaurante; el mesero ve "el restaurante abrió a las X"
 * pero no tiene un "su" turno aparte.
 */
export function shiftsAreIndividual(raw: string | null | undefined): boolean {
  return resolveShiftPolicy(raw) === "by_waiter";
}

/** UI helpers — copy en español para chips/badges. */
export const TIP_POLICY_LABELS: Record<TipPolicy, string> = {
  shared: "Compartidas",
  by_waiter: "Por mesero",
};

export const SHIFT_POLICY_LABELS: Record<ShiftPolicy, string> = {
  global: "Turno único del local",
  by_waiter: "Turno por mesero",
};

// === Quién puede NO COBRAR ==================================================
//
// "No cobrar" es anular el cobro de un plato ya entregado (queja, cortesía,
// cliente que se fue — `OrderItem.cancellationKind = "comp"`) o cerrar la
// cuenta completa como cortesía ($0). Es la vía más barata para que plata
// que entró no quede registrada, así que el dueño elige QUÉ ROLES pueden
// hacerlo. `Restaurant.compAllowedRoles` guarda la lista.
//
// Este módulo sigue siendo PURO (no importa `@/lib/db`): el guard que lee
// la política de la base vive en `src/lib/compGuard.ts`, igual que
// chargeControl.ts / chargeGuard.ts.

/**
 * Roles del personal que operan mesas y pueden aparecer en la lista.
 * `kitchen` / `bar` no cobran, así que no aplican; `platform_admin` y
 * `group_admin` no se listan porque pueden siempre (ver canCompOrders).
 */
export const COMP_ROLES = ["operator", "mesero", "terminal"] as const;
export type CompRole = (typeof COMP_ROLES)[number];

/** Default histórico + lo que pidió el dueño: sólo el administrador. */
export const DEFAULT_COMP_ALLOWED_ROLES: readonly CompRole[] = ["operator"];

/**
 * Código de error que devuelven las rutas de "no cobrar" cuando el rol no
 * está en la lista. El cliente lo traduce (`apiErrors.comp_not_allowed`);
 * nunca mandamos copy en español desde la API.
 */
export const COMP_NOT_ALLOWED_ERROR = "comp_not_allowed" as const;

/**
 * Roles que pueden no cobrar SIN pasar por la lista: el administrador de
 * la plataforma y el del grupo, que llegan impersonando al comercio. Son
 * quienes configuran la política, así que bloquearlos con ella no tiene
 * sentido (y en soporte hace falta poder destrabar una cuenta).
 */
const COMP_ALWAYS_ALLOWED = new Set<string>(["platform_admin", "group_admin"]);

export function isCompRole(role: string | null | undefined): role is CompRole {
  return !!role && (COMP_ROLES as readonly string[]).includes(role);
}

/**
 * Normaliza lo que viene de la base (o de un body): sólo roles válidos,
 * sin duplicados, en el orden canónico de COMP_ROLES.
 *
 *   - null / undefined ⇒ default (back-compat ante rollback o fila vieja).
 *   - []               ⇒ [] (el dueño eligió que NADIE del equipo pueda —
 *                          es una decisión válida, no un dato faltante).
 */
export function resolveCompAllowedRoles(
  raw: readonly string[] | null | undefined,
): CompRole[] {
  if (raw == null) return [...DEFAULT_COMP_ALLOWED_ROLES];
  const set = new Set(raw.filter(isCompRole));
  return COMP_ROLES.filter((r) => set.has(r));
}

/**
 * ¿Este rol puede no cobrar un plato o una cuenta en este comercio?
 *
 *   - platform_admin / group_admin ⇒ siempre (impersonan; ver arriba).
 *   - operator / mesero / terminal ⇒ sólo si están en la lista.
 *   - kitchen / bar / comensal (sin rol) / rol desconocido ⇒ nunca.
 *
 * `compAllowedRoles` es el valor crudo de `Restaurant.compAllowedRoles`;
 * se normaliza acá, así ningún llamador tiene que acordarse.
 */
export function canCompOrders(
  role: string | null | undefined,
  compAllowedRoles: readonly string[] | null | undefined,
): boolean {
  if (!role) return false;
  if (COMP_ALWAYS_ALLOWED.has(role)) return true;
  if (!isCompRole(role)) return false;
  return resolveCompAllowedRoles(compAllowedRoles).includes(role);
}

/**
 * Lo que la UI de mesas necesita saber de la política de "no cobrar":
 * si quien mira está bloqueado (esconder/deshabilitar el botón) y quiénes
 * SÍ pueden (para el aviso "Sólo puede hacerlo: …"). Lo arma el server
 * page y viaja por props hasta el detalle de la mesa.
 */
export type CompPolicyView = {
  locked: boolean;
  allowedRoles: CompRole[];
};
