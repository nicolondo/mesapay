// Mapa de calor día de la semana × hora — LÓGICA PURA.
//
// El día es el del DÍA OPERATIVO (una venta del sábado a la 01:00 es de la
// noche del viernes) y la hora es la del reloj en Bogotá. Las horas se
// ordenan desde la hora de corte (05:00 … 04:00) para que la noche no se
// parta, y se recortan a la franja con ventas: un local que abre de 12 a 23
// no necesita 24 columnas.
import { businessHourOrder } from "./period";

export type HeatRow = { dow: number; hour: number; netCents: number; orders: number };

export type HeatCell = { dow: number; hour: number; netCents: number; orders: number; level: number };

export type Heatmap = {
  /** 1 = lunes … 7 = domingo. */
  days: number[];
  /** Horas visibles, en orden del día operativo. */
  hours: number[];
  /** Fila por día, columna por hora visible. */
  cells: HeatCell[][];
  maxNetCents: number;
  totalNetCents: number;
  peak: HeatCell | null;
  byDay: { dow: number; netCents: number; orders: number }[];
  byHour: { hour: number; netCents: number; orders: number }[];
};

/** Pasos de la escala secuencial (0 = sin venta). */
export const HEAT_LEVELS = 6;

/** Nivel 1..HEAT_LEVELS de un valor contra el máximo; 0 sin venta. */
export function heatLevel(value: number, max: number, levels: number = HEAT_LEVELS): number {
  if (!(value > 0) || !(max > 0)) return 0;
  return Math.min(levels, Math.max(1, Math.ceil((value / max) * levels)));
}

export function buildHeatmap(rows: readonly HeatRow[], cutoffHour: number): Heatmap {
  const key = (dow: number, hour: number) => dow * 100 + hour;
  const map = new Map<number, HeatRow>();
  for (const r of rows) {
    if (r.dow < 1 || r.dow > 7 || r.hour < 0 || r.hour > 23) continue;
    const k = key(r.dow, r.hour);
    const prev = map.get(k);
    map.set(k, {
      dow: r.dow,
      hour: r.hour,
      netCents: (prev?.netCents ?? 0) + r.netCents,
      orders: (prev?.orders ?? 0) + r.orders,
    });
  }
  const order = businessHourOrder(cutoffHour);
  const active = order.filter((h) => [...map.values()].some((r) => r.hour === h && (r.orders > 0 || r.netCents > 0)));
  const hours = active.length === 0
    ? []
    : order.slice(order.indexOf(active[0]!), order.indexOf(active[active.length - 1]!) + 1);
  const days = [1, 2, 3, 4, 5, 6, 7];
  const maxNetCents = Math.max(0, ...[...map.values()].map((r) => r.netCents));
  let peak: HeatCell | null = null;
  const cells = days.map((dow) =>
    hours.map((hour) => {
      const r = map.get(key(dow, hour));
      const cell: HeatCell = {
        dow,
        hour,
        netCents: r?.netCents ?? 0,
        orders: r?.orders ?? 0,
        level: heatLevel(r?.netCents ?? 0, maxNetCents),
      };
      if (cell.netCents > 0 && (!peak || cell.netCents > peak.netCents)) peak = cell;
      return cell;
    }),
  );
  const values = [...map.values()];
  return {
    days,
    hours,
    cells,
    maxNetCents,
    totalNetCents: values.reduce((s, r) => s + r.netCents, 0),
    peak,
    byDay: days.map((dow) => ({
      dow,
      netCents: values.filter((r) => r.dow === dow).reduce((s, r) => s + r.netCents, 0),
      orders: values.filter((r) => r.dow === dow).reduce((s, r) => s + r.orders, 0),
    })),
    byHour: hours.map((hour) => ({
      hour,
      netCents: values.filter((r) => r.hour === hour).reduce((s, r) => s + r.netCents, 0),
      orders: values.filter((r) => r.hour === hour).reduce((s, r) => s + r.orders, 0),
    })),
  };
}
