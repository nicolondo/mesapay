// Serie de tendencia con su comparación superpuesta — LÓGICA PURA.
//
// El SQL sólo devuelve los baldes que vendieron; acá se rellenan con cero
// todos los del rango (un día sin ventas es un dato, no un hueco) y la serie
// de comparación se ALINEA por posición: el 3.er día del período contra el
// 3.er día del período de comparación. Si la comparación es más corta (un
// mes de 30 días contra uno de 31) el punto queda sin pareja.
import { bucketKeys, type DayRange, type Granularity } from "./period";

export type TrendRow = {
  bucket: string;
  netCents: number;
  /** Cuentas contadas en el balde (con «Hora del pedido», las abiertas en él). */
  orders: number;
  diners: number;
  /** Venta neta de esas cuentas, enteras (base del ticket del balde). */
  accountNetCents: number;
};

export type TrendPoint = {
  bucket: string;
  netCents: number;
  orders: number;
  diners: number;
  accountNetCents: number;
  /** Balde alineado de la comparación (null = sin comparación o sin pareja). */
  compareBucket: string | null;
  compareNetCents: number | null;
  compareOrders: number | null;
  compareDiners: number | null;
  compareAccountNetCents: number | null;
};

function fill(rows: readonly TrendRow[], keys: readonly string[]): TrendRow[] {
  const map = new Map(rows.map((r) => [r.bucket, r]));
  return keys.map((bucket) => map.get(bucket) ?? { bucket, netCents: 0, orders: 0, diners: 0, accountNetCents: 0 });
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
      compareAccountNetCents: c ? c.accountNetCents : null,
    };
  });
}

/**
 * Ticket de un punto (métrica «ticket» del gráfico): venta neta de las
 * cuentas contadas en el balde, enteras, ÷ esas cuentas. Con «Hora del
 * pedido» y vista por hora, la venta del balde (sólo lo pedido a esa hora)
 * no sirve de numerador: una mesa abierta a las 8 que volvió a pedir a las
 * 10 haría ver el ticket de las 8 más bajo y el de las 10 infinito.
 */
export function pointTicket(accountNetCents: number | null, orders: number | null): number | null {
  if (accountNetCents === null || orders === null || orders <= 0) return null;
  return Math.round(accountNetCents / orders);
}
