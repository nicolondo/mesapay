// Rótulos de fechas, horas y variaciones del análisis de ventas (puro: sirve
// en el servidor y en el cliente). Las fechas son DÍAS OPERATIVOS
// ("YYYY-MM-DD"), así que se formatean en UTC al mediodía: nunca retroceden
// un día por la zona horaria de quien mira.
import type { Locale } from "@/i18n/config";
import { formatDate, localeTag } from "@/lib/format";
import type { DayRange, Granularity } from "@/lib/salesAnalysis/period";

const noon = (iso: string) => new Date(`${iso}T12:00:00Z`);

function fmt(iso: string, locale: Locale, opts: Intl.DateTimeFormatOptions): string {
  return formatDate(noon(iso), { locale, timeZone: "UTC", dateStyle: undefined, timeStyle: undefined, ...opts });
}

/** «14 oct» */
export function fmtDayShort(iso: string, locale: Locale): string {
  return fmt(iso, locale, { day: "numeric", month: "short" });
}

/** «mié, 14 oct 2026» */
export function fmtDayLong(iso: string, locale: Locale): string {
  return fmt(iso, locale, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

/** «1–31 oct 2026» o el día suelto. */
export function fmtRange(range: DayRange, locale: Locale): string {
  if (range.from === range.to) return fmtDayLong(range.from, locale);
  const f = new Intl.DateTimeFormat(localeTag(locale), { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return f.formatRange(noon(range.from), noon(range.to));
}

/** «oct 2026» */
export function fmtMonth(month: string, locale: Locale): string {
  return fmt(`${month}-01`, locale, { month: "short", year: "numeric" });
}

/** Día de la semana ISO (1 = lunes) en el idioma de quien mira. */
export function weekdayName(dow: number, locale: Locale, width: "short" | "long" = "short"): string {
  // 2026-10-12 fue lunes.
  const day = 11 + dow;
  return fmt(`2026-10-${String(day).padStart(2, "0")}`, locale, { weekday: width });
}

/** «20:00» (reloj de 24 horas en todos los idiomas: es una franja, no una cita). */
export function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

/** Rótulo corto (eje) y largo (globo) de un balde de la tendencia. */
export function bucketLabel(
  key: string,
  granularity: Granularity,
  locale: Locale,
): { short: string; long: string; weekOf?: string } {
  switch (granularity) {
    case "hora": {
      const day = key.slice(0, 10);
      const hour = Number(key.slice(11, 13));
      return { short: hourLabel(hour), long: `${fmtDayLong(day, locale)} · ${hourLabel(hour)}` };
    }
    case "dia":
      return { short: fmtDayShort(key, locale), long: fmtDayLong(key, locale) };
    case "semana":
      return { short: fmtDayShort(key, locale), long: fmtDayLong(key, locale), weekOf: fmtDayShort(key, locale) };
    case "mes":
      return { short: fmt(`${key}-01`, locale, { month: "short" }), long: fmtMonth(key, locale) };
  }
}

/** «▲ 12,3 %» / «▼ 4,1 %» / «= 0 %». La flecha acompaña al color: nunca color solo. */
export function fmtDelta(delta: number, locale: Locale): string {
  const pct = new Intl.NumberFormat(localeTag(locale), { style: "percent", maximumFractionDigits: 1 }).format(Math.abs(delta));
  if (Math.abs(delta) < 0.0005) return `= ${pct}`;
  return `${delta > 0 ? "▲" : "▼"} ${pct}`;
}

export function fmtPercent(value: number, locale: Locale): string {
  return new Intl.NumberFormat(localeTag(locale), { style: "percent", maximumFractionDigits: 1 }).format(value);
}

export function fmtNumber(value: number, locale: Locale, digits = 0): string {
  return new Intl.NumberFormat(localeTag(locale), { maximumFractionDigits: digits }).format(value);
}

/** «1 h 15 min» / «48 min». */
export function fmtMinutes(minutes: number, labels: { h: string; min: string }): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h > 0 ? `${h} ${labels.h} ${m} ${labels.min}` : `${m} ${labels.min}`;
}
