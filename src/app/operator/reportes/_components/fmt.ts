import type { Locale } from "@/i18n/config";
import { formatDate } from "@/lib/format";

/**
 * Fechas de los reportes. Los límites del período y las fechas de los
 * asientos son UTC (ver `period.ts`), así que se formatean en UTC: un
 * asiento fechado `2026-08-31T23:59:59.999Z` es «31 ago 2026» y no «31
 * ago 18:59» de Bogotá, y un `desde=2026-08-01` no retrocede al 31 de
 * julio.
 */
export function fmtIsoDate(iso: string, locale: Locale): string {
  const d = iso.length === 10 ? new Date(`${iso}T00:00:00Z`) : new Date(iso);
  return formatDate(d, { locale, dateStyle: "medium", timeStyle: undefined, timeZone: "UTC" });
}

/** Fecha numérica corta («01/01/2026» en es), para rótulos compactos. */
export function fmtIsoDateNumeric(iso: string, locale: Locale): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  // `formatDate` pone dateStyle/timeStyle por defecto e Intl no admite
  // mezclarlos con componentes sueltos: se anulan explícitamente.
  return formatDate(d, {
    locale,
    timeZone: "UTC",
    dateStyle: undefined,
    timeStyle: undefined,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

/** Mes y año («ene 2026») de un `yyyy-mm`, para las columnas mensuales. */
export function fmtMonth(month: string, locale: Locale): string {
  const d = new Date(`${month}-01T00:00:00Z`);
  return formatDate(d, {
    locale,
    timeZone: "UTC",
    dateStyle: undefined,
    timeStyle: undefined,
    month: "short",
    year: "numeric",
  });
}
