import { addDaysIso, bogotaBusinessTodayIso, bogotaDayRange } from "@/lib/bogota";

export type OrderPeriod = "today" | "7d" | "30d" | "all";

/**
 * Inicio del período del listado de órdenes, contado en días OPERATIVOS del
 * comercio (`Restaurant.businessDayCutoffHour`, hora Bogotá). Con corte 5,
 * "Hoy" arranca hoy a las 05:00 y lo que se vendió entre las 00:00 y las
 * 05:00 cuenta para el día anterior: el mismo criterio del Resumen, los
 * reportes y el cierre del día. Antes el listado cortaba a la medianoche
 * del reloj del servidor y la madrugada aparecía como un día nuevo.
 *
 * `7d`/`30d` incluyen el día operativo de hoy (hoy − 6 / hoy − 29).
 * `null` = sin filtro de fecha.
 */
export function orderPeriodStart(period: OrderPeriod, cutoffHour: number): Date | null {
  if (period === "all") return null;
  const todayIso = bogotaBusinessTodayIso(cutoffHour);
  const daysBack = period === "7d" ? 6 : period === "30d" ? 29 : 0;
  return bogotaDayRange(addDaysIso(todayIso, -daysBack), cutoffHour).start;
}
