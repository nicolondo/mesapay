// Interpretación de números ESCRITOS o PEGADOS por una persona («1,234.56»,
// «$ 25,000», «1.234.567,89» de una planilla vieja…) → texto canónico para el
// estado/API: dígitos, punto decimal, sin miles ("1234.56").
//
// Convención de MESAPAY (ver `@/lib/format`): miles «,» y decimales «.».
// Reglas, sin adivinar:
//  - Coma Y punto juntos: el ÚLTIMO es el decimal (una sola vez, con dígitos
//    después) y el otro agrupa de a 3 → «1,234,567.89» y también el formato
//    viejo «1.234.567,89» (sin ambigüedad: hay dos separadores distintos).
//  - Solo comas: si agrupan bien de a 3 son miles («1,250» = 1250,
//    «1,234,567»). Una sola coma que NO puede ser de miles («12,5», «0,05»,
//    «12,») es la coma decimal de los teclados en español → decimal.
//  - Solo puntos: uno solo es el decimal («1.25» = 1.25, «1.250» = 1.25).
//    Varios que agrupan de a 3 son miles del formato viejo («1.234.567»):
//    un decimal no se repite, así que no hay ambigüedad.
//  - `maxFractionDigits`: si sobran decimales se RECHAZA (null) — p. ej.
//    «25.000» en un campo de plata con 0 o 2 decimales puede ser 25 (nuevo)
//    o 25000 (viejo): no se adivina. Excepción: hasta 2 ceros que sobran
//    («1,234.00» en un campo entero) se descartan, no cambian el valor.
//  - Cualquier otra cosa (letras, «1e6», agrupación rota «12,34,567») → null.

const CURRENCY_NOISE = /\b(?:COP|MXN|BRL|USD|EUR)\b|R\$|[$€£\s  ]/gi;

function groupsOfThree(text: string, separator: string): boolean {
  const parts = text.split(separator);
  return (
    parts.length > 1 &&
    /^\d{1,3}$/.test(parts[0]) &&
    parts.slice(1).every((p) => /^\d{3}$/.test(p))
  );
}

export function normalizeNumberText(
  raw: string,
  opts: { allowNegative?: boolean; maxFractionDigits?: number } = {},
): string | null {
  const text = raw.trim().replace(CURRENCY_NOISE, "");
  const negative = text.startsWith("-");
  if (negative && !opts.allowNegative) return null;
  const body = negative ? text.slice(1) : text;
  if (!/^[\d.,]+$/.test(body) || !/\d/.test(body)) return null;

  const dots = body.split(".").length - 1;
  const commas = body.split(",").length - 1;
  let integer: string;
  let fraction: string | undefined;

  if (dots === 0 && commas === 0) {
    integer = body;
  } else if (dots > 0 && commas > 0) {
    const at = Math.max(body.lastIndexOf("."), body.lastIndexOf(","));
    const decimal = body[at];
    const group = decimal === "." ? "," : ".";
    integer = body.slice(0, at);
    fraction = body.slice(at + 1);
    if (body.indexOf(decimal) !== at || fraction === "") return null;
    if (!groupsOfThree(integer, group)) return null;
    integer = integer.split(group).join("");
  } else if (commas > 0) {
    if (groupsOfThree(body, ",")) {
      integer = body.split(",").join("");
    } else if (commas === 1) {
      [integer, fraction] = body.split(",");
    } else return null;
  } else if (dots === 1) {
    [integer, fraction] = body.split(".");
  } else if (groupsOfThree(body, ".")) {
    integer = body.split(".").join("");
  } else return null;

  if (fraction !== undefined && opts.maxFractionDigits !== undefined) {
    if (fraction.length > opts.maxFractionDigits) {
      const surplus = fraction.slice(opts.maxFractionDigits);
      if (fraction.length > 2 || !/^0+$/.test(surplus)) return null;
      fraction = fraction.slice(0, opts.maxFractionDigits);
      if (fraction === "") fraction = undefined;
    }
  }
  integer = integer.replace(/^0+(?=\d)/, "") || "0";
  return (negative ? "-" : "") + integer + (fraction !== undefined ? "." + fraction : "");
}
