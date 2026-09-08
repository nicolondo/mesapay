// Entrada de números decimales tolerante al separador.
//
// Un <input type="number"> NO sirve para cantidades decimales en esta app:
// el navegador valida contra el locale y, con coma decimal, devuelve "" al
// teclear "0,05" — el valor llegaba como 0 y el guardado fallaba con un
// error genérico. Se usa type="text" + inputMode="decimal" (el teclado
// numérico en móvil se conserva) y se filtra/parsea acá.
//
// El usuario puede escribir coma O punto indistintamente: en Colombia y
// Brasil la coma es lo natural, en inglés el punto, y nadie debería tener
// que acordarse de cuál acepta la pantalla.

/**
 * Deja pasar sólo dígitos y UN separador decimal (coma o punto), en el
 * orden en que se tecleó. Pensado para el `onChange` del input, así el
 * usuario nunca ve un carácter que después se va a rechazar.
 *
 * Admite un signo `-` inicial cuando `allowNegative` (deltas de modificador).
 */
export function sanitizeDecimalInput(
  raw: string,
  { allowNegative = false }: { allowNegative?: boolean } = {},
): string {
  const negative = allowNegative && raw.trimStart().startsWith("-");
  const cleaned = raw.replace(/[^\d.,]/g, "");
  const firstSep = cleaned.search(/[.,]/);
  const body =
    firstSep === -1
      ? cleaned
      : cleaned.slice(0, firstSep + 1) +
        cleaned.slice(firstSep + 1).replace(/[.,]/g, "");
  return negative ? "-" + body : body;
}

/**
 * Convierte lo tecleado a número, tratando la coma como separador decimal.
 * Devuelve NaN si está vacío o no es un número — el caller decide qué hacer
 * (no se asume 0, que era justo el bug: "" → 0 → "cantidad inválida").
 */
export function parseDecimalInput(raw: string): number {
  const trimmed = raw.trim();
  if (trimmed === "") return NaN;
  return Number(trimmed.replace(",", "."));
}
