// Entrada de números decimales (cantidades, porcentajes, minutos…).
//
// Un <input type="number"> NO sirve para cantidades decimales en esta app:
// el navegador valida contra el locale y, con coma decimal, devuelve "" al
// teclear "0,05" — el valor llegaba como 0 y el guardado fallaba con un
// error genérico. Se usa type="text" + inputMode="decimal" (el teclado
// numérico en móvil se conserva) y se filtra/parsea acá.
//
// Convención de MESAPAY (ver `@/lib/format`): el decimal es el PUNTO. Estos
// campos no agrupan miles, así que el separador que se teclee —punto, o la
// coma que traen los teclados numéricos en español— es el decimal y se ve
// de inmediato como «.» (lo que se ve es lo que se guarda). Lo pegado sigue
// las reglas de `@/lib/numberText` («1,250» = 1250, «1.234,5» = 1234.5).

import { normalizeNumberText } from "@/lib/numberText";

/**
 * Deja pasar sólo dígitos y UN separador decimal, mostrado como punto. Pensado
 * para el `onChange` del input, así el usuario nunca ve un carácter que
 * después se va a rechazar.
 *
 * Admite un signo `-` inicial cuando `allowNegative` (deltas de modificador).
 */
export function sanitizeDecimalInput(
  raw: string,
  { allowNegative = false }: { allowNegative?: boolean } = {},
): string {
  const negative = allowNegative && raw.trimStart().startsWith("-");
  const cleaned = raw.replace(/[^\d.,]/g, "");
  let body = cleaned;
  if (/[.,]/.test(cleaned)) {
    const normalized = normalizeNumberText(cleaned);
    if (normalized !== null) body = normalized;
    else {
      // Un segundo separador tecleado (o algo pegado que no se entiende):
      // se queda el primero, como decimal, y se descartan los demás.
      const first = cleaned.search(/[.,]/);
      body =
        cleaned.slice(0, first) +
        "." +
        cleaned.slice(first + 1).replace(/[.,]/g, "");
    }
  }
  return negative ? "-" + body : body;
}

/**
 * Convierte lo tecleado a número (punto decimal; tolera la coma decimal y lo
 * pegado con miles, ver `@/lib/numberText`). Devuelve NaN si está vacío o no
 * es un número — el caller decide qué hacer (no se asume 0, que era justo el
 * bug: "" → 0 → "cantidad inválida").
 */
export function parseDecimalInput(raw: string): number {
  const trimmed = raw.trim();
  if (trimmed === "") return NaN;
  const normalized = normalizeNumberText(trimmed, { allowNegative: true });
  return normalized === null ? NaN : Number(normalized);
}
