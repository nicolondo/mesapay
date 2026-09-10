import { localeTag } from "@/lib/format";
import type { Locale } from "@/i18n/config";

export function moneySeparators(locale: Locale) {
  const parts = new Intl.NumberFormat(localeTag(locale)).formatToParts(1234.5);
  return {
    group: parts.find((p) => p.type === "group")!.value,
    decimal: parts.find((p) => p.type === "decimal")!.value,
  };
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

/** Parse an edited, locale-formatted field. Invalid input is rejected, never
 * converted into a different amount by dropping letters or a negative sign. */
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

/** Accept pasted currency / spreadsheet values in either common notation.
 * A lone separator followed by 3 digits is grouping; 1–2 digits is decimal.
 * Fractional pasted amounts are rejected for integer-only fields. */
export function parseMoneyPaste(
  raw: string,
  locale: Locale,
  fractionDigits = 0,
  allowNegative = false,
): string | null {
  let text = raw
    .trim()
    .replace(/\b(?:COP|MXN|BRL|USD|EUR)\b/gi, "")
    .replace(/R\$|[$€£\s]/g, "");
  if (!/^-?[\d.,]+$/.test(text)) return null;
  const dot = text.lastIndexOf("."),
    comma = text.lastIndexOf(",");
  const last = Math.max(dot, comma);
  const decimalAt =
    last >= 0 && ((dot >= 0 && comma >= 0) || text.length - last - 1 <= 2)
      ? last
      : -1;
  if (decimalAt >= 0) {
    if (!fractionDigits || text.length - decimalAt - 1 > fractionDigits)
      return null;
    text =
      text.slice(0, decimalAt).replace(/[.,]/g, "") +
      "." +
      text.slice(decimalAt + 1);
  } else text = text.replace(/[.,]/g, "");
  return parseMoneyInput(
    formatMoneyInput(text, locale, fractionDigits),
    locale,
    fractionDigits,
    allowNegative,
  );
}
