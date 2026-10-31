// Períodos del análisis de ventas — LÓGICA PURA, sin DB ni reloj.
//
// Todo se expresa en DÍAS OPERATIVOS del comercio ("YYYY-MM-DD"), no en días
// calendario: con hora de corte 5, el día operativo 14 va del 14 a las 05:00
// al 15 a las 05:00 (hora Bogotá), así la noche de trabajo no se parte en
// medianoche. Es el mismo criterio del Resumen, del cierre del día y del
// listado de órdenes (`bogotaDayRange` / `bogotaBusinessDateIso`).
//
// Un rango es [from, to] con los dos extremos INCLUIDOS. Los instantes para
// la consulta salen de `rangeInstants`: [inicio del día `from`, fin del día
// `to`), medio abierto como el resto de los reportes.
import { addDaysIso, bogotaDayRange } from "@/lib/bogota";

export type DayRange = { from: string; to: string };

export const PERIOD_PRESETS = [
  "hoy",
  "ayer",
  "semana",
  "semana-pasada",
  "mes",
  "mes-pasado",
  "7d",
  "30d",
  "90d",
  "anio",
] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];
/** Un preset o un rango personalizado (`desde`/`hasta`). */
export type PeriodKind = PeriodPreset | "rango";

export const COMPARE_MODES = ["anterior", "anio", "no"] as const;
export type CompareMode = (typeof COMPARE_MODES)[number];

export const GRANULARITIES = ["hora", "dia", "semana", "mes"] as const;
export type Granularity = (typeof GRANULARITIES)[number];

/** Tope del rango personalizado: dos años de días operativos. */
export const MAX_RANGE_DAYS = 732;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** ¿Es una fecha "YYYY-MM-DD" real (no 2026-02-31)? */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1) return false;
  return d <= daysInMonth(y, mo);
}

function parts(iso: string): [number, number, number] {
  const [y, m, d] = iso.split("-").map(Number);
  return [y, m, d];
}

function iso(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Días entre dos fechas ISO (b − a). */
export function diffDays(a: string, b: string): number {
  const [ay, am, ad] = parts(a);
  const [by, bm, bd] = parts(b);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** Cantidad de días operativos del rango (ambos extremos incluidos). */
export function rangeDays(range: DayRange): number {
  return diffDays(range.from, range.to) + 1;
}

/** Día de la semana ISO de una fecha: 1 = lunes … 7 = domingo. */
export function isoWeekday(date: string): number {
  const [y, m, d] = parts(date);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 ? 7 : dow;
}

/** Lunes de la semana de `date` (las semanas arrancan el lunes). */
export function weekStart(date: string): string {
  return addDaysIso(date, 1 - isoWeekday(date));
}

function monthStart(date: string): string {
  const [y, m] = parts(date);
  return iso(y, m, 1);
}

function monthEnd(date: string): string {
  const [y, m] = parts(date);
  return iso(y, m, daysInMonth(y, m));
}

/** Suma meses a una fecha, recortando el día al largo del mes destino. */
export function addMonthsClamped(date: string, months: number): string {
  const [y, m, d] = parts(date);
  const index = y * 12 + (m - 1) + months;
  const ty = Math.floor(index / 12);
  const tm = (index % 12) + 1;
  return iso(ty, tm, Math.min(d, daysInMonth(ty, tm)));
}

/** ¿El rango son meses calendario completos (del 1 al último día)? */
function fullMonths(range: DayRange): number | null {
  if (range.from !== monthStart(range.from) || range.to !== monthEnd(range.to)) return null;
  const [fy, fm] = parts(range.from);
  const [ty, tm] = parts(range.to);
  return (ty - fy) * 12 + (tm - fm) + 1;
}

/** Rango de días operativos de un preset, con `today` = día operativo de hoy. */
export function presetRange(preset: PeriodPreset, today: string): DayRange {
  switch (preset) {
    case "hoy":
      return { from: today, to: today };
    case "ayer": {
      const y = addDaysIso(today, -1);
      return { from: y, to: y };
    }
    case "semana":
      return { from: weekStart(today), to: today };
    case "semana-pasada": {
      const monday = addDaysIso(weekStart(today), -7);
      return { from: monday, to: addDaysIso(monday, 6) };
    }
    case "mes":
      return { from: monthStart(today), to: today };
    case "mes-pasado": {
      const last = addDaysIso(monthStart(today), -1);
      return { from: monthStart(last), to: last };
    }
    case "7d":
      return { from: addDaysIso(today, -6), to: today };
    case "30d":
      return { from: addDaysIso(today, -29), to: today };
    case "90d":
      return { from: addDaysIso(today, -89), to: today };
    case "anio": {
      const [y] = parts(today);
      return { from: iso(y, 1, 1), to: today };
    }
  }
}

/**
 * Período de comparación.
 *
 *  · `anterior`: el período inmediatamente anterior y del mismo largo. Si el
 *    rango son meses completos, los meses completos anteriores (septiembre
 *    contra agosto, no contra «los 30 días antes»). «Este mes» (en curso)
 *    se compara con los mismos días del mes anterior, «esta semana» con los
 *    mismos días de la semana pasada y «este año» con el mismo tramo del año
 *    anterior.
 *  · `anio`: las mismas fechas un año antes (el 29 de febrero cae en el 28);
 *    meses completos contra los mismos meses completos.
 *  · `no`: sin comparación.
 */
export function comparisonRange(
  range: DayRange,
  kind: PeriodKind,
  mode: CompareMode,
): DayRange | null {
  if (mode === "no") return null;
  const months = fullMonths(range);
  if (mode === "anio") {
    if (months) {
      const from = addMonthsClamped(range.from, -12);
      return { from, to: monthEnd(addMonthsClamped(range.to, -12)) };
    }
    return { from: addMonthsClamped(range.from, -12), to: addMonthsClamped(range.to, -12) };
  }
  // «Este año» antes que la regla de meses completos: el 31 de octubre el
  // año en curso son diez meses completos, pero se compara con el año pasado.
  if (kind === "anio") {
    return { from: addMonthsClamped(range.from, -12), to: addMonthsClamped(range.to, -12) };
  }
  if (months) {
    const from = addMonthsClamped(range.from, -months);
    return { from, to: monthEnd(addMonthsClamped(range.to, -months)) };
  }
  if (kind === "mes") {
    const from = addMonthsClamped(range.from, -1);
    return { from, to: addMonthsClamped(range.to, -1) };
  }
  if (kind === "semana") {
    return { from: addDaysIso(range.from, -7), to: addDaysIso(range.to, -7) };
  }
  const days = rangeDays(range);
  return { from: addDaysIso(range.from, -days), to: addDaysIso(range.to, -days) };
}

/** Instantes [start, end) de la consulta para el rango, con la hora de corte. */
export function rangeInstants(range: DayRange, cutoffHour: number): { start: Date; end: Date } {
  return {
    start: bogotaDayRange(range.from, cutoffHour).start,
    end: bogotaDayRange(range.to, cutoffHour).end,
  };
}

// ── Granularidad ────────────────────────────────────────────────────────────

/** Granularidad automática según el largo del rango. */
export function autoGranularity(range: DayRange): Granularity {
  const days = rangeDays(range);
  if (days <= 1) return "hora";
  if (days <= 62) return "dia";
  if (days <= 190) return "semana";
  return "mes";
}

/** Granularidades que tienen sentido para el rango (ni un solo punto ni miles). */
export function allowedGranularities(range: DayRange): Granularity[] {
  const days = rangeDays(range);
  const out: Granularity[] = [];
  if (days <= 7) out.push("hora");
  if (days >= 2 && days <= 400) out.push("dia");
  if (days >= 14) out.push("semana");
  if (days >= 45) out.push("mes");
  return out;
}

/** La pedida si es válida para el rango; si no, la automática. */
export function resolveGranularity(range: DayRange, requested: Granularity | "auto"): Granularity {
  if (requested !== "auto" && allowedGranularities(range).includes(requested)) return requested;
  return autoGranularity(range);
}

/** Orden de las horas dentro del día operativo: arranca en la hora de corte. */
export function businessHourOrder(cutoffHour: number): number[] {
  return Array.from({ length: 24 }, (_, i) => (cutoffHour + i) % 24);
}

/**
 * Claves de TODOS los baldes del rango, en orden, para rellenar con cero los
 * que no vendieron (una línea sin el día vacío mentiría):
 *  · hora   → "YYYY-MM-DDTHH" (día operativo + hora del reloj; la 01:00 del
 *             día operativo 14 es la madrugada del 15 calendario);
 *  · día    → "YYYY-MM-DD";
 *  · semana → "YYYY-MM-DD" del lunes;
 *  · mes    → "YYYY-MM".
 */
export function bucketKeys(range: DayRange, granularity: Granularity, cutoffHour: number): string[] {
  const days = Array.from({ length: rangeDays(range) }, (_, i) => addDaysIso(range.from, i));
  if (granularity === "dia") return days;
  if (granularity === "hora") {
    const hours = businessHourOrder(cutoffHour);
    return days.flatMap((d) => hours.map((h) => `${d}T${String(h).padStart(2, "0")}`));
  }
  if (granularity === "semana") return [...new Set(days.map(weekStart))];
  return [...new Set(days.map((d) => d.slice(0, 7)))];
}

/** Rango de días que cubre un balde, recortado al rango consultado (drill-down). */
export function bucketRange(key: string, granularity: Granularity, within: DayRange): DayRange {
  const clamp = (r: DayRange): DayRange => ({
    from: r.from < within.from ? within.from : r.from,
    to: r.to > within.to ? within.to : r.to,
  });
  if (granularity === "hora" || granularity === "dia") {
    const day = key.slice(0, 10);
    return { from: day, to: day };
  }
  if (granularity === "semana") return clamp({ from: key, to: addDaysIso(key, 6) });
  const first = `${key}-01`;
  return clamp({ from: first, to: monthEnd(first) });
}
