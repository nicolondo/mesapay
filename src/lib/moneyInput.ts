import { NUMBER_SEPARATORS } from "@/lib/format";
import { normalizeNumberText } from "@/lib/numberText";
import type { Locale } from "@/i18n/config";

/** Separadores de los campos de plata: la convención de MESAPAY (miles «,»,
 * decimales «.») en todos los idiomas — ver `@/lib/format`. */
export function moneySeparators(_locale?: Locale) {
  return { group: NUMBER_SEPARATORS.group, decimal: NUMBER_SEPARATORS.decimal };
}

/** State/API values are ungrouped major units with a dot decimal separator. */
export function formatMoneyInput(
  value: string | number,
  locale: Locale,
  fractionDigits = 0,
): string {
  const raw = String(value);
  if (!/^-?\d*(?:\.\d*)?$/.test(raw)) return "";
  const negative = raw.startsWith("-");
  const [integer, fraction] = raw.replace(/^-/, "").split(".");
  const { group, decimal } = moneySeparators(locale);
  const grouped = integer
    .replace(/^0+(?=\d)/, "")
    .replace(/\B(?=(\d{3})+(?!\d))/g, group);
  return (
    (negative ? "-" : "") +
    grouped +
    (fractionDigits > 0 && fraction !== undefined
      ? decimal + fraction.slice(0, fractionDigits)
      : "")
  );
}

/** Parse an edited, formatted field («1,234.5»). Invalid input is rejected,
 * never converted into a different amount by dropping letters or a sign. */
export function parseMoneyInput(
  raw: string,
  locale: Locale,
  fractionDigits = 0,
  allowNegative = false,
): string | null {
  const { group, decimal } = moneySeparators(locale);
  let text = raw.split(group).join("").replace(/\s/g, "");
  if (decimal !== ".") text = text.replace(decimal, ".");
  if (
    !/^-?\d*(?:\.\d*)?$/.test(text) ||
    (!allowNegative && text.startsWith("-"))
  )
    return null;
  const [whole, fraction] = text.split(".");
  if (whole.replace("-", "").length > 12) return null;
  if (
    fraction !== undefined &&
    (fractionDigits === 0 || fraction.length > fractionDigits)
  )
    return null;
  text = text.replace(/^(-?)0+(?=\d)/, "$1");
  if (text.startsWith(".")) text = "0" + text;
  if (text.startsWith("-.")) text = "-0" + text.slice(1);
  return text;
}

/**
 * Lo que se TECLEA en un campo de plata que ya agrupa solo. Los teclados
 * numéricos de iPhone/Android en español traen la COMA como tecla decimal
 * (y a veces ninguna tecla de punto), así que en un campo con decimales la
 * coma tecleada se toma como el punto decimal y se ve de inmediato como
 * «.»; los miles nunca hace falta escribirlos. En un campo entero la coma
 * y el punto tecleados no hacen nada.
 *
 * Detecta el caso en que el navegador no reporta la tecla (Android manda
 * `Unidentified` en keydown): un único carácter «,» insertado respecto a
 * lo que se mostraba. Devuelve el texto a interpretar.
 */
export function typedDecimalComma(
  previous: string,
  next: string,
  caret: number,
  fractionDigits: number,
): string {
  if (!fractionDigits || next.length !== previous.length + 1) return next;
  const at = caret - 1;
  if (at < 0 || next[at] !== ",") return next;
  if (next.slice(0, at) + next.slice(at + 1) !== previous) return next;
  if (previous.includes(NUMBER_SEPARATORS.decimal)) return previous;
  return next.slice(0, at) + NUMBER_SEPARATORS.decimal + next.slice(at + 1);
}

/** Lo PEGADO (planilla, factura, otro sistema). Reglas en `@/lib/numberText`:
 * acepta la convención nueva («1,234.56») y el formato viejo cuando no hay
 * ambigüedad («1.234.567,89»); lo ambiguo («1.250» en un campo de 2
 * decimales) se rechaza en vez de adivinar. */
export function parseMoneyPaste(
  raw: string,
  locale: Locale,
  fractionDigits = 0,
  allowNegative = false,
): string | null {
  const text = normalizeNumberText(raw, { allowNegative, maxFractionDigits: fractionDigits });
  if (text === null) return null;
  return parseMoneyInput(
    formatMoneyInput(text, locale, fractionDigits),
    locale,
    fractionDigits,
    allowNegative,
  );
}
