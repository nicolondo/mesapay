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
