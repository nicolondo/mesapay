// Días de NEGOCIO de un mes contable — lógica pura, sin DB.
//
// El motor (posting.ts) asienta las fuentes transaccionales por día de
// negocio del comercio: el día de Bogotá con la hora de corte
// (`Restaurant.businessDayCutoffHour`), el mismo criterio del cierre de día
// y del análisis de ventas (`bogotaBusinessDateIso` / `bogotaDayRange`).
// Con corte 5, el día "2026-10-17" va de las 05:00 del 17 a las 05:00 del
// 18 (hora de Bogotá): la cena de las 23:30 y el último cobro de las 02:00
// caen en el mismo asiento.
//
// El mes de negocio `YYYY-MM` son los días de negocio 1..último de ese mes;
// su rango UTC va del comienzo del día 1 al final del último día, así que
// NO coincide con el mes UTC (`monthRange`) ni con el calendario de Bogotá.
import { bogotaDayRange } from "@/lib/bogota";
import { isoDateUtc } from "./reports/period";

export type BusinessDay = {
  /** "YYYY-MM-DD". */
  day: string;
  /** Primer instante del día (incluido). */
  from: Date;
  /** Primer instante del día siguiente (excluido). */
  to: Date;
};

const MONTH_RE = /^(\d{4})-(\d{2})$/;

/** Primer y último día ("YYYY-MM-DD") de un mes válido; null si no lo es. */
function monthBounds(month: string): { first: string; last: string; days: number } | null {
  const m = MONTH_RE.exec(month);
  if (!m) return null;
  const year = Number(m[1]);
  const mon = Number(m[2]);
  if (year < 2020 || year > 2100 || mon < 1 || mon > 12) return null;
  const days = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return {
    first: `${m[1]}-${m[2]}-01`,
    last: `${m[1]}-${m[2]}-${String(days).padStart(2, "0")}`,
    days,
  };
}

/**
 * Los días de negocio del mes `month` ("YYYY-MM"), en orden, cada uno con
 * su rango UTC `[from, to)` según la hora de corte. `[]` si el mes no es
 * válido (misma regla que `monthRange`: años 2020–2100).
 */
export function businessDaysOfMonth(month: string, cutoffHour: number): BusinessDay[] {
  const bounds = monthBounds(month);
  if (!bounds) return [];
  const out: BusinessDay[] = [];
  for (let i = 1; i <= bounds.days; i++) {
    const day = `${month}-${String(i).padStart(2, "0")}`;
    const { start, end } = bogotaDayRange(day, cutoffHour);
    out.push({ day, from: start, to: end });
  }
  return out;
}

/**
 * Rango UTC `[from, to)` del MES DE NEGOCIO: del comienzo del primer día de
 * negocio al final del último. Es el rango con el que el motor carga los
 * hechos fechados por timestamp (cobros, recepciones, movimientos de
 * inventario, reembolsos, abonos). null si el mes no es válido.
 */
export function businessMonthRange(
  month: string,
  cutoffHour: number,
): { from: Date; to: Date } | null {
  const days = businessDaysOfMonth(month, cutoffHour);
  if (days.length === 0) return null;
  return { from: days[0]!.from, to: days[days.length - 1]!.to };
}

/**
 * Fecha con la que se guarda el asiento diario del día `day`: la medianoche
 * de Bogotá de ese día, `YYYY-MM-DDT05:00:00.000Z`. Cae dentro del día
 * calendario UTC `day`, así que todo lo que corta por fecha en UTC (los
 * reportes con `periodToUtcRange`, el cierre con `date < 1.º del mes
 * siguiente`, el Diario por `monthRange`) lo ubica en el día y el mes
 * correctos sin tocar nada.
 */
export function dailyEntryDate(day: string): Date {
  return new Date(`${day}T05:00:00.000Z`);
}

/**
 * Día calendario de un campo FECHA (gastos, turnos): el DATE vive a
 * medianoche UTC —o a mediodía, si lo eligió el operador—, así que su día
 * es el de UTC, nunca el de negocio (restarle el corte lo movería al día
 * anterior).
 */
export function calendarDayOf(date: Date): string {
  return isoDateUtc(date);
}
