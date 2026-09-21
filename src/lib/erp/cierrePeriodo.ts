// Cierre de período — lógica PURA de la página /operator/contabilidad/cierre:
// la lista de meses del año con su estado (cerrado / abierto / futuro y
// cuántos comprobantes tiene cada uno), cuál es el próximo mes por cerrar y
// el parseo del año pedido por URL. Sin DB ni React: se testea sola. Las
// operaciones (cerrar, reabrir, cierre anual) siguen en `cierre.ts` y
// `fiscal.ts`, detrás de sus rutas de API.
import type { Locale } from "@/i18n/config";
import { formatDate } from "@/lib/format";

/** Conteo de comprobantes de un mes (`numbered` = con número asignado). */
export type MonthCount = { month: string; entries: number; numbered: number };

export type MonthStatus = {
  /** YYYY-MM */
  month: string;
  closed: boolean;
  /** Posterior al mes en curso: no tiene sentido cerrarlo todavía. */
  future: boolean;
  entries: number;
  numbered: number;
  /** El botón «Cerrar mes» va acá: es el próximo de la secuencia y no es futuro. */
  canClose: boolean;
};

export type YearStatus = {
  year: number;
  months: MonthStatus[];
  /**
   * Próximo mes a cerrar en la secuencia (el que sigue al último cerrado, o
   * el primero con comprobantes si nunca se cerró). Puede caer fuera del año
   * mostrado; null si no hay nada que cerrar todavía.
   */
  nextToClose: string | null;
  closedInYear: number;
  allClosed: boolean;
};

/** Primer año aceptado por URL (mismo piso que `monthRange` del motor). */
export const MIN_YEAR = 2020;

const MONTH_RE = /^\d{4}-\d{2}$/;

export function isMonth(v: string | null | undefined): v is string {
  return v != null && MONTH_RE.test(v) && Number(v.slice(5)) >= 1 && Number(v.slice(5)) <= 12;
}

/** "2026-01" → "2026-02"; "2025-12" → "2026-01". */
export function nextMonthOf(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y!, m!, 1)).toISOString().slice(0, 7);
}

export function monthsOfYear(year: number): string[] {
  return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
}

/**
 * `?year=` → año a mostrar. Sólo un año de cuatro cifras entre MIN_YEAR y el
 * año siguiente al actual; cualquier otra cosa → el año en curso.
 */
export function parseYearParam(
  raw: string | string[] | undefined,
  currentYear: number,
): number {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v || !/^\d{4}$/.test(v)) return currentYear;
  const year = Number(v);
  return year >= MIN_YEAR && year <= currentYear + 1 ? year : currentYear;
}

/** Ver `YearStatus.nextToClose`. */
export function nextMonthToClose(
  closedThrough: string | null,
  firstEntryMonth: string | null,
): string | null {
  if (closedThrough) return nextMonthOf(closedThrough);
  return firstEntryMonth ?? null;
}

export function buildYearStatus(input: {
  year: number;
  /** `AccountingConfig.closedThrough` (YYYY-MM o null). */
  closedThrough: string | null;
  counts: readonly MonthCount[];
  /** Mes en curso (YYYY-MM), para marcar futuros. */
  currentMonth: string;
  /** Mes del comprobante más antiguo del comercio (o null si no hay ninguno). */
  firstEntryMonth: string | null;
}): YearStatus {
  const byMonth = new Map(input.counts.map((c) => [c.month, c]));
  const nextToClose = nextMonthToClose(input.closedThrough, input.firstEntryMonth);
  const months = monthsOfYear(input.year).map((month): MonthStatus => {
    const c = byMonth.get(month);
    // Misma regla que `isMonthClosed` (cierre.ts): comparación lexicográfica.
    const closed = input.closedThrough != null && month <= input.closedThrough;
    const future = month > input.currentMonth;
    return {
      month,
      closed,
      future,
      entries: c?.entries ?? 0,
      numbered: c?.numbered ?? 0,
      canClose: !closed && !future && month === nextToClose,
    };
  });
  const closedInYear = months.filter((m) => m.closed).length;
  return { year: input.year, months, nextToClose, closedInYear, allClosed: closedInYear === 12 };
}

/** «Enero de 2026» — rótulo largo de un YYYY-MM en el idioma del usuario. */
export function formatMonthLong(month: string, locale: Locale): string {
  const label = formatDate(new Date(`${month}-01T00:00:00Z`), {
    locale,
    timeZone: "UTC",
    // `formatDate` trae dateStyle/timeStyle por defecto e Intl no los mezcla
    // con componentes sueltos: se anulan explícitamente.
    dateStyle: undefined,
    timeStyle: undefined,
    month: "long",
    year: "numeric",
  });
  return label.charAt(0).toUpperCase() + label.slice(1);
}
