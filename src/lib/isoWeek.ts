/**
 * Número de semana ISO 8601 de una fecha `yyyy-mm-dd` (lógica pura).
 *
 * Las semanas van de lunes a domingo y la semana 1 del año es la que
 * contiene el primer jueves (equivalente: la que contiene el 4 de enero).
 * Por eso el 29–31 de diciembre pueden ser de la semana 1 del año
 * siguiente, y el 1–3 de enero de la semana 52/53 del anterior: `year` es
 * el AÑO DE LA SEMANA, no el de la fecha. Es el mismo criterio con el que
 * los reportes cortan las semanas (`weekRangeUtc`, `weekStart`) y el que
 * entienden el contador y Excel (`ISOWEEKNUM`).
 */
export function isoWeekNumber(iso: string): { year: number; week: number } {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  // Jueves de la semana de la fecha: fija el año ISO.
  const dow = date.getUTCDay() || 7; // 1 = lunes … 7 = domingo
  date.setUTCDate(date.getUTCDate() + 4 - dow);
  const isoYear = date.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return { year: isoYear, week };
}
