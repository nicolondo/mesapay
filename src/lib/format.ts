import { defaultLocale, type Locale } from "@/i18n/config";

// COP (Colombian peso) formatting — no decimals, . as thousand separator
export function fmtCOP(cents: number): string {
  const pesos = Math.round(cents / 100);
  return "$" + pesos.toLocaleString("es-CO", { maximumFractionDigits: 0 });
}

export function fmtCOPlong(cents: number): string {
  const pesos = Math.round(cents / 100);
  return "$" + pesos.toLocaleString("es-CO") + " COP";
}

export function pesosToCents(pesos: number): number {
  return Math.round(pesos * 100);
}

// ─────────────────────────────────────────────────────────────────────────
// Formateo localizado (i18n). Idioma ≠ moneda: el `locale` controla idioma
// y agrupación de miles; la `currency` la define el país del restaurante
// (COP, MXN, BRL…), no el idioma del comensal. Los nuevos desarrollos
// multi-país deberían usar formatMoney/formatDate en vez de fmtCOP.
// ─────────────────────────────────────────────────────────────────────────
const LOCALE_TAG: Record<Locale, string> = {
  es: "es-CO",
  en: "en-US",
  pt: "pt-BR",
};

/** Monedas que se muestran sin decimales. */
const ZERO_DECIMAL = new Set(["COP", "CLP", "PYG", "JPY"]);

export function localeTag(locale: Locale = defaultLocale): string {
  return LOCALE_TAG[locale] ?? LOCALE_TAG[defaultLocale];
}

export function formatMoney(
  cents: number,
  opts?: { currency?: string; locale?: Locale },
): string {
  const currency = (opts?.currency ?? "COP").toUpperCase();
  const zeroDecimal = ZERO_DECIMAL.has(currency);
  const amount = zeroDecimal ? Math.round(cents / 100) : cents / 100;
  return new Intl.NumberFormat(localeTag(opts?.locale), {
    style: "currency",
    currency,
    minimumFractionDigits: zeroDecimal ? 0 : 2,
    maximumFractionDigits: zeroDecimal ? 0 : 2,
  }).format(amount);
}

export function formatDate(
  date: Date | string | number,
  opts?: { locale?: Locale; timeZone?: string } & Intl.DateTimeFormatOptions,
): string {
  const { locale, timeZone, ...dtOpts } = opts ?? {};
  return new Intl.DateTimeFormat(localeTag(locale), {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timeZone ?? "America/Bogota",
    ...dtOpts,
  }).format(new Date(date));
}
