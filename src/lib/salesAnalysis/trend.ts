// Serie de tendencia con su comparación superpuesta — LÓGICA PURA.
//
// El SQL sólo devuelve los baldes que vendieron; acá se rellenan con cero
// todos los del rango (un día sin ventas es un dato, no un hueco) y la serie
// de comparación se ALINEA por posición: el 3.er día del período contra el
// 3.er día del período de comparación. Si la comparación es más corta (un
// mes de 30 días contra uno de 31) el punto queda sin pareja.
import { bucketKeys, type DayRange, type Granularity } from "./period";

export type TrendRow = { bucket: string; netCents: number; orders: number; diners: number };

export type TrendPoint = {
  bucket: string;
  netCents: number;
  orders: number;
  diners: number;
  /** Balde alineado de la comparación (null = sin comparación o sin pareja). */
  compareBucket: string | null;
  compareNetCents: number | null;
  compareOrders: number | null;
  compareDiners: number | null;
};

function fill(rows: readonly TrendRow[], keys: readonly string[]): TrendRow[] {
  const map = new Map(rows.map((r) => [r.bucket, r]));
  return keys.map((bucket) => map.get(bucket) ?? { bucket, netCents: 0, orders: 0, diners: 0 });
}

export function buildTrend(args: {
  rows: readonly TrendRow[];
  range: DayRange;
  compareRows: readonly TrendRow[] | null;
  compareRange: DayRange | null;
  granularity: Granularity;
  cutoffHour: number;
}): TrendPoint[] {
  const current = fill(args.rows, bucketKeys(args.range, args.granularity, args.cutoffHour));
  const compare = args.compareRows && args.compareRange
    ? fill(args.compareRows, bucketKeys(args.compareRange, args.granularity, args.cutoffHour))
    : null;
  return current.map((p, i) => {
    const c = compare?.[i];
    return {
      ...p,
      compareBucket: c?.bucket ?? null,
      compareNetCents: c ? c.netCents : null,
      compareOrders: c ? c.orders : null,
      compareDiners: c ? c.diners : null,
    };
  });
}

/** Venta neta / cuentas de un punto (para la métrica «ticket» del gráfico). */
export function pointTicket(netCents: number | null, orders: number | null): number | null {
  if (netCents === null || orders === null || orders <= 0) return null;
  return Math.round(netCents / orders);
}
