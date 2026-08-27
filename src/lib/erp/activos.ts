// Activos fijos — depreciación en línea recta mensual (port del núcleo puro
// de zenith-erp). Reglas: la depreciación arranca el MES SIGUIENTE al de la
// compra; la cuota mensual es (compra − salvamento) / vida útil, redondeada
// al centavo; el ÚLTIMO mes absorbe el residuo para que la suma cierre
// exacta. El asiento mensual (D 516005 · C 159205) lo arma el motor de
// posting como un summary más del mes.
import { db } from "@/lib/db";

export type ScheduleAsset = {
  purchaseCents: number;
  salvageCents: number;
  /** ISO date (o Date) de compra. */
  purchaseDate: string | Date;
  usefulLifeMonths: number;
};

/** "YYYY-MM" del mes SIGUIENTE al de la fecha dada (primer mes depreciable). */
export function startMonth(purchaseDate: string | Date): string {
  const d = new Date(purchaseDate);
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return next.toISOString().slice(0, 7);
}

/** Suma n meses a un "YYYY-MM". */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y!, (m ?? 1) - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

/** Base depreciable en centavos (compra − salvamento, nunca negativa). */
function depreciableBase(a: ScheduleAsset): number {
  return Math.max(0, a.purchaseCents - a.salvageCents);
}

/**
 * Cuota del activo para un mes "YYYY-MM" (0 si está fuera de la vida útil).
 * Meses 1..n-1: round(base/vida). Mes n: base − cuota×(n−1) (residuo).
 */
export function depreciationForAssetMonth(
  a: ScheduleAsset,
  month: string,
): number {
  if (a.usefulLifeMonths <= 0) return 0;
  const base = depreciableBase(a);
  if (base <= 0) return 0;
  const start = startMonth(a.purchaseDate);
  if (month < start) return 0;
  const last = addMonths(start, a.usefulLifeMonths - 1);
  if (month > last) return 0;
  const cuota = Math.round(base / a.usefulLifeMonths);
  if (month < last) return cuota;
  return base - cuota * (a.usefulLifeMonths - 1);
}

/** Depreciación acumulada del activo HASTA un mes inclusive. */
export function accumulatedThrough(a: ScheduleAsset, month: string): number {
  if (a.usefulLifeMonths <= 0) return 0;
  const base = depreciableBase(a);
  if (base <= 0) return 0;
  const start = startMonth(a.purchaseDate);
  if (month < start) return 0;
  const last = addMonths(start, a.usefulLifeMonths - 1);
  if (month >= last) return base;
  // Meses transcurridos desde start hasta month, inclusive.
  const [sy, sm] = start.split("-").map(Number);
  const [my, mm] = month.split("-").map(Number);
  const elapsed = (my! - sy!) * 12 + (mm! - sm!) + 1;
  return Math.round(base / a.usefulLifeMonths) * elapsed;
}

/**
 * Depreciación total del comercio para un mes: suma de las cuotas de los
 * activos ACTIVOS (los dados de baja dejan de depreciar desde su baja).
 */
export async function depreciationForMonth(
  restaurantId: string,
  month: string,
): Promise<number> {
  const assets = await db.fixedAsset.findMany({
    where: { restaurantId, active: true },
    select: {
      purchaseCents: true,
      salvageCents: true,
      purchaseDate: true,
      usefulLifeMonths: true,
      disposedAt: true,
    },
  });
  let total = 0;
  for (const a of assets) {
    if (a.disposedAt && a.disposedAt.toISOString().slice(0, 7) <= month) {
      continue;
    }
    total += depreciationForAssetMonth(a, month);
  }
  return total;
}
