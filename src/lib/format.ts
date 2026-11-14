import { defaultLocale, isLocale, type Locale } from "@/i18n/config";

// ─────────────────────────────────────────────────────────────────────────
// Convención de números de MESAPAY: miles con «,» y decimales con «.»
// («$1,234,567» y «1,234.56»), pedido del dueño para la operación en
// Colombia. Aplica a TODOS los idiomas (es/en/pt) y a todos los comercios:
// el formato sigue al negocio, no al idioma de quien mira (un comensal que
// lee en portugués ve los mismos números que el mesero). Es GLOBAL a
// propósito — hoy todos los comercios operan en Colombia —; si algún día
// hace falta por comercio, este es el único punto a cambiar.
//
// Lo que NO cambia:
//  - Las fechas: siguen con el locale del idioma (`localeTag`).
//  - El símbolo y la posición de la moneda (Intl, por idioma).
//  - Lo fiscal: el XML de la DIAN no pasa por acá; usa `toFixed` (punto
//    decimal, sin miles) en `src/lib/dian/**`.
//
// Todo formateo de números para mostrar (pantallas, tirillas ESC/POS,
// correos, PDF, gráficos) debe pasar por este módulo: `formatMoney`,
// `formatNumber`, `fmtCOP` o `numberFormatter` (reemplazo directo de
// `new Intl.NumberFormat(...)`). Nada de `toLocaleString("es-CO")` suelto.
// ─────────────────────────────────────────────────────────────────────────
export const NUMBER_SEPARATORS = { group: ",", decimal: "." } as const;

/** Separadores de miles y decimales con los que se muestran los números. */
export function numberSeparators(): { group: string; decimal: string } {
  return { ...NUMBER_SEPARATORS };
}

const LOCALE_TAG: Record<Locale, string> = {
  es: "es-CO",
  en: "en-US",
  pt: "pt-BR",
};

/** Etiqueta BCP-47 del idioma — para FECHAS y listas. Los números usan
 * `numberFormatter`, que aplica además la convención de separadores. */
export function localeTag(locale: Locale = defaultLocale): string {
  return LOCALE_TAG[locale] ?? LOCALE_TAG[defaultLocale];
}

/** Acepta el idioma de la app ("es") o una etiqueta completa ("es-CO"). */
function tagOf(locale?: string | null): string {
  if (!locale) return localeTag(defaultLocale);
  return isLocale(locale) ? localeTag(locale) : locale;
}

export type NumberFormatter = {
  format(value: number | bigint): string;
  formatToParts(value: number | bigint): Intl.NumberFormatPart[];
};

const cache = new Map<string, NumberFormatter>();

/**
 * Igual que `new Intl.NumberFormat(locale, options)` pero con los
 * separadores de MESAPAY (miles «,», decimales «.»). Conserva todo lo
 * demás de Intl (símbolo y posición de la moneda, `%`, notación compacta,
 * signo). `locale` puede ser el idioma de la app ("es") o una etiqueta.
 */
export function numberFormatter(
  locale?: string | null,
  options?: Intl.NumberFormatOptions,
): NumberFormatter {
  const tag = tagOf(locale);
  const key = `${tag}|${JSON.stringify(options ?? {})}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const intl = new Intl.NumberFormat(tag, options);
  const formatToParts = (value: number | bigint) =>
    intl.formatToParts(value).map((p) =>
      p.type === "group"
        ? { ...p, value: NUMBER_SEPARATORS.group }
        : p.type === "decimal"
          ? { ...p, value: NUMBER_SEPARATORS.decimal }
          : p,
    );
  const formatter: NumberFormatter = {
    formatToParts,
    format: (value) =>
      formatToParts(value)
        .map((p) => p.value)
        .join(""),
  };
  if (cache.size > 500) cache.clear();
  cache.set(key, formatter);
  return formatter;
}

/** Entero agrupado con la convención («1,234,567»). */
function groupInteger(value: number): string {
  return numberFormatter(defaultLocale, { maximumFractionDigits: 0 }).format(value);
}

// COP (Colombian peso) — sin decimales: «$1,234,567».
export function fmtCOP(cents: number): string {
  return "$" + groupInteger(Math.round(cents / 100));
}

export function fmtCOPlong(cents: number): string {
  return "$" + groupInteger(Math.round(cents / 100)) + " COP";
}

export function pesosToCents(pesos: number): number {
  return Math.round(pesos * 100);
}

/**
 * Agrupa un monto ENTERO (string de dígitos) con el separador de miles de
 * la convención — para los inputs de plata enteros. Ignora todo lo que no
 * sea dígito, recorta a 12 cifras (evita perder precisión de Number) y
 * quita ceros a la izquierda. "" → "".
 */
export function groupThousands(
  digits: string,
  // El idioma ya no cambia los separadores; se conserva por compatibilidad.
  _locale: Locale = defaultLocale,
): string {
  const clean = digits.replace(/\D/g, "").slice(0, 12);
  if (clean === "") return "";
  return groupInteger(Number(clean));
}

// ─────────────────────────────────────────────────────────────────────────
// Formateo localizado (i18n). Idioma ≠ moneda: el `locale` controla el
// idioma (símbolo/posición de la moneda); la `currency` la define el país
// del restaurante (COP, MXN, BRL…), no el idioma del comensal.
// ─────────────────────────────────────────────────────────────────────────

/** Monedas que se muestran sin decimales. */
const ZERO_DECIMAL = new Set(["COP", "CLP", "PYG", "JPY"]);

/** ¿La moneda se usa sin decimales (COP)? Para redondear precios calculados. */
export function isZeroDecimalCurrency(currency: string): boolean {
  return ZERO_DECIMAL.has(currency.toUpperCase());
}

/** Valor numérico con la convención, sin asumir moneda ni cambiar unidades. */
export function formatNumber(
  value: number,
  opts?: { locale?: Locale; maximumFractionDigits?: number; minimumFractionDigits?: number },
): string {
  return numberFormatter(opts?.locale, {
    minimumFractionDigits: opts?.minimumFractionDigits ?? 0,
    maximumFractionDigits: opts?.maximumFractionDigits ?? 2,
  }).format(value);
}

/**
 * Precisión de `formatMoney`:
 *  - 0 / 2: fija.
 *  - "auto": en monedas sin decimales (COP) muestra los centavos SOLO si
 *    el valor los tiene («$1,234» y «$1,234.56»); para lo que se digita
 *    con 2 decimales (compras, gastos, facturas de proveedor) sin ensuciar
 *    los valores redondos.
 *  - sin indicar: la de la moneda (COP redondea a pesos).
 */
export type MoneyFractionDigits = 0 | 2 | "auto";

export function formatMoney(
  cents: number,
  opts?: { currency?: string; locale?: Locale; fractionDigits?: MoneyFractionDigits },
): string {
  const currency = (opts?.currency ?? "COP").toUpperCase();
  const zeroDecimalCurrency = ZERO_DECIMAL.has(currency);
  const requested = opts?.fractionDigits;
  const fractionDigits =
    requested === "auto"
      ? zeroDecimalCurrency && Math.round(cents) % 100 === 0
        ? 0
        : 2
      : (requested ?? (zeroDecimalCurrency ? 0 : 2));
  const amount = fractionDigits === 0 ? Math.round(cents / 100) : cents / 100;
  return numberFormatter(opts?.locale, {
    style: "currency",
    currency,
    // "$ 229,499" y no "COP 229,499": en es-CO Intl ya usa "$", pero en
    // en/pt antepone el código ISO — ruido visual (reporte del usuario).
    // narrowSymbol unifica con fmtCOP ("$X") en toda la app. No hay
    // ambigüedad COP/MXN: cada comercio ve una sola moneda (su país).
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(amount);
}

/** Porcentaje con la convención: 0.125 → «12.5%». */
export function formatPercent(
  ratio: number,
  opts?: { locale?: Locale; maximumFractionDigits?: number; minimumFractionDigits?: number },
): string {
  return numberFormatter(opts?.locale, {
    style: "percent",
    minimumFractionDigits: opts?.minimumFractionDigits ?? 0,
    maximumFractionDigits: opts?.maximumFractionDigits ?? 1,
  }).format(ratio);
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
