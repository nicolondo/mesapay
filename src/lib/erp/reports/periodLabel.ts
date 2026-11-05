/**
 * Rótulos de un período (`desde`/`hasta` ISO): los comparten el selector de
 * los reportes (`ReportPeriod`) y el de la lista de Órdenes. Sin React ni
 * DB: sólo `Intl` vía `@/lib/format`.
 *
 * Las fechas de un período son días calendario (UTC en los reportes, días
 * de negocio en Órdenes): se formatean SIEMPRE en UTC para que el 1 del mes
 * no retroceda al día anterior por el desfase de Bogotá.
 */
import type { Locale } from "@/i18n/config";
import { formatDate, localeTag } from "@/lib/format";
import type { PeriodStep, ReportPeriod } from "./period";

function utcDate(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

/**
 * Espacios finos/duros de Intl → espacio normal. El ICU de Node y el del
 * navegador no usan los mismos alrededor del «–» de un rango («2 – 8 nov»):
 * el rótulo que arma el servidor no coincidía con el del cliente (error de
 * hidratación en el selector de período).
 */
function plainSpaces(s: string): string {
  return s.replace(/[\u00a0\u2009\u202f]/g, " ");
}

/**
 * «2 – 8 nov 2026», «28 oct – 3 nov 2026», «29 dic 2026 – 4 ene 2027».
 * Con `year: false` («2 – 8 nov») cuando el año se sobreentiende; si el
 * rango cruza de año, el año va igual.
 */
export function rangeLabel(
  period: ReportPeriod,
  locale: Locale,
  { year = true }: { year?: boolean } = {},
): string {
  const withYear = year || period.desde.slice(0, 4) !== period.hasta.slice(0, 4);
  const f = new Intl.DateTimeFormat(localeTag(locale), {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    ...(withYear ? { year: "numeric" as const } : {}),
  });
  const a = utcDate(period.desde);
  const b = utcDate(period.hasta);
  return plainSpaces(
    typeof f.formatRange === "function" ? f.formatRange(a, b) : `${f.format(a)} – ${f.format(b)}`,
  );
}

/** «Noviembre de 2026» (con mayúscula inicial, como un título). */
export function monthLabel(iso: string, locale: Locale): string {
  // `formatDate` trae dateStyle/timeStyle por defecto e Intl no admite
  // mezclarlos con componentes sueltos: se anulan explícitamente.
  const s = formatDate(utcDate(iso), {
    locale,
    timeZone: "UTC",
    dateStyle: undefined,
    timeStyle: undefined,
    month: "long",
    year: "numeric",
  });
  return plainSpaces(s.charAt(0).toLocaleUpperCase(localeTag(locale)) + s.slice(1));
}

/**
 * Un día con su día de la semana: «sáb, 1 nov»; con el año si no es el
 * del día de referencia («mié, 31 dic 2025»).
 */
export function weekdayDateLabel(iso: string, locale: Locale, referenceIso: string): string {
  return plainSpaces(formatDate(utcDate(iso), {
    locale,
    timeZone: "UTC",
    dateStyle: undefined,
    timeStyle: undefined,
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(iso.slice(0, 4) !== referenceIso.slice(0, 4) ? { year: "numeric" as const } : {}),
  }));
}

/**
 * Rótulo de una unidad completa: «2026», «Octubre de 2026», «26 oct – 1
 * nov 2026».
 */
export function unitLabel(kind: PeriodStep, period: ReportPeriod, locale: Locale): string {
  if (kind === "año") return period.desde.slice(0, 4);
  if (kind === "mes") return monthLabel(period.desde, locale);
  return rangeLabel(period, locale);
}
