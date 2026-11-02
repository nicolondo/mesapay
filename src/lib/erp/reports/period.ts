/**
 * Período de los reportes contables (lógica pura, sin DB ni React).
 *
 * Portado de `zenith-erp/reportes/fiscal-year.ts` + `report-period.tsx`.
 * El ejercicio en MESAPAY es el año natural (el cierre anual en
 * `fiscal.ts` cancela 4/5/6 contra 3605/3610 el 31-dic), así que las
 * mismas reglas aplican tal cual.
 *
 * ── Zona horaria ────────────────────────────────────────────────────────
 * Los asientos automáticos del motor (`posting.ts`) se fechan dentro del
 * día calendario UTC al que pertenecen: los diarios a la medianoche de
 * Bogotá de su día de negocio (`YYYY-MM-DDT05:00:00Z`, ver
 * `businessDays.ts`) y los mensuales al ÚLTIMO instante UTC del mes
 * (`monthRange` usa `Date.UTC`); el cierre mensual corta con `date <
 * inicio del mes siguiente` también en UTC. Para que un asiento del 31 de
 * agosto nunca caiga en septiembre por un desfase horario, los límites de
 * todos los reportes se calculan en UTC: `desde` a las 00:00Z y `hasta`
 * EXCLUSIVO a las 00:00Z del día siguiente. `todayIso` sí mira la hora
 * local del comercio (Bogotá): es lo que el usuario entiende por hoy.
 */

export type ReportPeriod = { desde: string; hasta: string };

export type ResolvedPeriod = ReportPeriod & {
  /** Año elegido cuando el período ES un ejercicio completo. */
  year: number | null;
  mode: "ejercicio" | "rango";
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** ¿Es una fecha `yyyy-mm-dd` REAL (no acepta 2026-02-31)? */
export function isIsoDate(v: string | undefined | null): v is string {
  if (!v || !ISO_DATE.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** `yyyy-mm-dd` de un instante, leído en UTC. */
export function isoDateUtc(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/**
 * Hoy, en la zona horaria del comercio. Bogotá por defecto: los comercios
 * de MESAPAY son colombianos y los formateadores de `@/lib/format` también
 * asumen esa zona.
 */
export function todayIso(now: Date = new Date(), timeZone = "America/Bogota"): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Rango del ejercicio: el año natural completo, ambos extremos incluidos. */
export function fiscalYearRange(year: number): ReportPeriod {
  const y = String(year).padStart(4, "0");
  return { desde: `${y}-01-01`, hasta: `${y}-12-31` };
}

/** El año del rango si el rango ES exactamente un ejercicio completo. */
export function fiscalYearOf(desde: string, hasta: string): number | null {
  const m = /^(\d{4})-01-01$/.exec(desde);
  if (!m) return null;
  return hasta === `${m[1]}-12-31` ? Number(m[1]) : null;
}

/** Año de la URL: cuatro dígitos entre 2000 y 2999, o null. */
export function parseYear(raw: string | undefined | null): number | null {
  if (!raw || !/^\d{4}$/.test(raw)) return null;
  const y = Number(raw);
  return y >= 2000 && y <= 2999 ? y : null;
}

/**
 * Período efectivo de un reporte a partir de la URL. Orden de mando:
 *
 *  1. `desde`/`hasta` explícitos (se rellena el que falte: `desde` → 1 de
 *     enero del año en curso, `hasta` → hoy);
 *  2. `anio` válido y sin fechas → el ejercicio completo;
 *  3. nada → «1 de enero del año en curso → hoy».
 *
 * Los valores que no sean fechas válidas se ignoran como si no vinieran.
 */
export function resolveReportPeriod({
  anio,
  desde,
  hasta,
  today,
}: {
  anio?: string | null;
  desde?: string | null;
  hasta?: string | null;
  today: string;
}): ResolvedPeriod {
  const yearStart = `${today.slice(0, 4)}-01-01`;
  const from = isIsoDate(desde) ? desde : undefined;
  const to = isIsoDate(hasta) ? hasta : undefined;
  if (from || to) {
    const d = from ?? yearStart;
    const h = to ?? today;
    const year = fiscalYearOf(d, h);
    return { desde: d, hasta: h, year, mode: year == null ? "rango" : "ejercicio" };
  }
  const parsed = parseYear(anio);
  if (parsed != null) {
    return { ...fiscalYearRange(parsed), year: parsed, mode: "ejercicio" };
  }
  return { desde: yearStart, hasta: today, year: null, mode: "rango" };
}

/** Primer y último día (ISO) de un mes `yyyy-mm`; null si no es un mes. */
export function monthRangeUtc(month: string): ReportPeriod | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return null;
  const y = Number(m[1]);
  const mon = Number(m[2]);
  if (mon < 1 || mon > 12) return null;
  const lastDay = new Date(Date.UTC(y, mon, 0)).getUTCDate();
  return {
    desde: `${m[1]}-${m[2]}-01`,
    hasta: `${m[1]}-${m[2]}-${pad2(lastDay)}`,
  };
}

/** El mes en curso completo (para el libro diario, cuyo paso natural es el mes). */
export function currentMonthPeriod(today: string): ReportPeriod {
  return monthRangeUtc(today.slice(0, 7)) ?? { desde: today, hasta: today };
}

/**
 * Unidad del selector de período: semana (lunes a domingo), mes o año
 * naturales completos, o un rango libre de fechas.
 */
export type PeriodKind = "semana" | "mes" | "año" | "rango";
/** Las unidades completas: lo que pueden saltar las flechas. */
export type PeriodStep = Exclude<PeriodKind, "rango">;

/**
 * Lunes a domingo (ISO 8601) de la semana que contiene `dateIso`, en UTC.
 * La semana empieza en lunes como en Colombia y en el resto de LATAM; el
 * domingo de inicio es convención de EE. UU.
 */
export function weekRangeUtc(dateIso: string): ReportPeriod {
  const d = new Date(`${dateIso}T00:00:00Z`);
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - sinceMonday);
  const desde = isoDateUtc(d);
  d.setUTCDate(d.getUTCDate() + 6);
  return { desde, hasta: isoDateUtc(d) };
}

/** La semana, el mes o el año completo que contiene `dateIso`. */
export function unitRange(dateIso: string, step: PeriodStep): ReportPeriod {
  if (step === "año") return fiscalYearRange(Number(dateIso.slice(0, 4)));
  if (step === "mes") {
    return monthRangeUtc(dateIso.slice(0, 7)) ?? { desde: dateIso, hasta: dateIso };
  }
  return weekRangeUtc(dateIso);
}

/**
 * Qué es el período: un año completo, un mes completo, una semana completa
 * (lunes a domingo) o un rango libre. Se deduce del propio par de fechas,
 * así la URL no necesita un parámetro extra y un enlace compartido abre
 * con el mismo modo. No hay ambigüedad: una semana son 7 días, un mes
 * 28–31 y un año 365–366.
 */
export function periodKind(period: ReportPeriod): PeriodKind {
  if (fiscalYearOf(period.desde, period.hasta) != null) return "año";
  const month = monthRangeUtc(period.desde.slice(0, 7));
  if (month && month.desde === period.desde && month.hasta === period.hasta) return "mes";
  const week = weekRangeUtc(period.desde);
  if (week.desde === period.desde && week.hasta === period.hasta) return "semana";
  return "rango";
}

/**
 * Pasa el período a una unidad completa al cambiar de modo. Ancla en HOY
 * si hoy cae dentro del rango actual (de «1 de enero → hoy» a Mes se va
 * al mes en curso, que es lo que uno espera), y si no en `hasta` (desde
 * octubre completo a Semana se va a la última semana de octubre, no a la
 * de hoy).
 */
export function snapPeriod(
  period: ReportPeriod,
  step: PeriodStep,
  today: string,
): ReportPeriod {
  const anchor = period.desde <= today && today <= period.hasta ? today : period.hasta;
  return unitRange(anchor, step);
}

/**
 * Mueve el período una semana, un mes o un año completo hacia atrás o
 * adelante. El salto parte del `desde` (como en zenith): con `step: "mes"`
 * el resultado es el mes completo anterior/siguiente aunque el rango de
 * partida fuera libre; igual con la semana (lunes a domingo) y el año.
 */
export function shiftPeriod(
  period: ReportPeriod,
  step: PeriodStep,
  dir: -1 | 1,
): ReportPeriod {
  if (step === "año") {
    return fiscalYearRange(Number(period.desde.slice(0, 4)) + dir);
  }
  if (step === "semana") {
    const monday = new Date(`${weekRangeUtc(period.desde).desde}T00:00:00Z`);
    monday.setUTCDate(monday.getUTCDate() + 7 * dir);
    return weekRangeUtc(isoDateUtc(monday));
  }
  const base = new Date(`${period.desde.slice(0, 7)}-01T00:00:00Z`);
  base.setUTCMonth(base.getUTCMonth() + dir);
  return monthRangeUtc(base.toISOString().slice(0, 7)) ?? period;
}

/**
 * Límites UTC para la consulta: `from` inclusivo (00:00Z del `desde`) y
 * `to` EXCLUSIVO (00:00Z del día siguiente al `hasta`). Es el mismo
 * convenio `gte/lt` del resto del ERP.
 */
export function periodToUtcRange(period: ReportPeriod): { from: Date; to: Date } {
  const [fy, fm, fd] = period.desde.split("-").map(Number);
  const [ty, tm, td] = period.hasta.split("-").map(Number);
  return {
    from: new Date(Date.UTC(fy, fm - 1, fd)),
    to: new Date(Date.UTC(ty, tm - 1, td + 1)),
  };
}
