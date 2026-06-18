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
//   - "auto_open": abrimos el turno del local automáticamente con base 0
//                  y el del mesero también con base 0 (luego se editan).
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
