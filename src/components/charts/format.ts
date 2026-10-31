// Formato de valores de los gráficos: una descripción SERIALIZABLE (el
// servidor no puede pasarle funciones a un componente de cliente) que el
// gráfico convierte en texto con `@/lib/format`. Moneda = país del comercio;
// locale = idioma de quien mira.
import type { Locale } from "@/i18n/config";
import { formatMoney, localeTag } from "@/lib/format";

export type ValueFormat =
  | { kind: "money"; currency: string; locale: Locale }
  | { kind: "number"; locale: Locale; digits?: number }
  | { kind: "percent"; locale: Locale };

export function formatValue(value: number, f: ValueFormat): string {
  if (f.kind === "money") return formatMoney(value, { currency: f.currency, locale: f.locale });
  if (f.kind === "percent") {
    return new Intl.NumberFormat(localeTag(f.locale), { style: "percent", maximumFractionDigits: 1 }).format(value);
  }
  return new Intl.NumberFormat(localeTag(f.locale), {
    maximumFractionDigits: f.digits ?? 0,
    minimumFractionDigits: 0,
  }).format(value);
}

/** Compacto para los ejes: «$ 1,2 M», «12 mil», «3.400». */
export function formatCompact(value: number, f: ValueFormat): string {
  if (f.kind === "percent") return formatValue(value, f);
  const amount = f.kind === "money" ? value / 100 : value;
  return new Intl.NumberFormat(localeTag(f.locale), {
    notation: "compact",
    maximumFractionDigits: 1,
    ...(f.kind === "money" ? { style: "currency", currency: f.currency, currencyDisplay: "narrowSymbol" } : {}),
  }).format(amount);
}

/** Tope «redondo» del eje y sus marcas (0 y tres más), para que el eje no tenga cifras raras. */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0];
  const raw = max / (count - 1);
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow;
  return Array.from({ length: count }, (_, i) => i * step);
}
