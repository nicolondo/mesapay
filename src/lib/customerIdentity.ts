/**
 * Identidad del comensal: normalización de cédula y resolución del
 * identificador de login.
 *
 * Funciones PURAS a propósito (sin DB, sin red) para que se puedan probar
 * con vitest, que corre en `environment: node` sin base de datos.
 */

/** Largo mínimo/máximo aceptado para una cédula ya normalizada. */
export const CEDULA_MIN_LEN = 5;
export const CEDULA_MAX_LEN = 20;

/**
 * Normaliza una cédula a su forma canónica: sin puntos, guiones, espacios
 * ni caracteres raros, y en mayúsculas.
 *
 * El porqué: la misma persona escribe "1.020.304", "1 020 304" y
 * "1020304" según el día. Si guardáramos el texto crudo, el índice UNIQUE
 * dejaría crear tres cuentas para el mismo documento y el login por cédula
 * fallaría según cómo la tecleen. Guardamos siempre la forma canónica y
 * normalizamos también al buscar.
 *
 * Se aceptan letras porque hay documentos alfanuméricos (pasaporte, cédula
 * de extranjería) y el comensal extranjero también come.
 */
export function normalizeCedula(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw.replace(/[^0-9a-zA-Z]/g, "").toUpperCase();
}

/** true si la cédula normalizada tiene una forma plausible. */
export function isValidCedula(raw: string | null | undefined): boolean {
  const c = normalizeCedula(raw);
  return c.length >= CEDULA_MIN_LEN && c.length <= CEDULA_MAX_LEN;
}

export type LoginIdentifier =
  | { kind: "email"; value: string }
  | { kind: "cedula"; value: string }
  | { kind: "invalid" };

/**
 * Decide si lo que el comensal escribió en el campo único de login es un
 * correo o una cédula, y devuelve el valor ya normalizado para consultar la
 * DB (correo en minúsculas, cédula canónica).
 *
 * La regla es la @: no hay documento de identidad con arroba, así que la
 * ambigüedad no existe.
 */
export function resolveLoginIdentifier(
  raw: string | null | undefined,
): LoginIdentifier {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { kind: "invalid" };

  if (trimmed.includes("@")) {
    const email = trimmed.toLowerCase();
    // Validación mínima — la real la hace el UNIQUE de la DB al no
    // encontrar nada. Evita mandar basura obvia al query.
    if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) return { kind: "invalid" };
    return { kind: "email", value: email };
  }

  const cedula = normalizeCedula(trimmed);
  if (!isValidCedula(cedula)) return { kind: "invalid" };
  return { kind: "cedula", value: cedula };
}
