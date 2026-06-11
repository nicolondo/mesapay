import { defaultLocale, type Locale } from "@/i18n/config";

// COP (Colombian peso) formatting — no decimals, . as thousand separator
export function fmtCOP(cents: number): string {
  return "$" + fmtMiles(cents / 100);
}

export function fmtCOPlong(cents: number): string {
  return "$" + fmtMiles(cents / 100) + " COP";
}

/** Agrupación de miles es-CO sin "$" — para máscaras de input y plantillas
 *  donde el símbolo o el "COP" van aparte. Recibe pesos (no centavos);
 *  la agrupación es de la moneda (país del restaurante), no del idioma. */
export function fmtMiles(pesos: number): string {
  return Math.round(pesos).toLocaleString("es-CO", {
    maximumFractionDigits: 0,
  });
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
  // Intl no permite mezclar dateStyle/timeStyle con opciones por componente
  // (hour, day…) — tira TypeError. El default aplica solo cuando el caller
  // no trae formato propio.
  const fmt: Intl.DateTimeFormatOptions = Object.keys(dtOpts).length
    ? dtOpts
    : { dateStyle: "medium", timeStyle: "short" };
  return new Intl.DateTimeFormat(localeTag(locale), {
    ...fmt,
    timeZone: timeZone ?? "America/Bogota",
  }).format(new Date(date));
}
