/** Moneda de cobro según país ISO alpha-2 del comercio. Default COP. */
export function currencyForCountry(country: string | null | undefined): "COP" | "MXN" {
  return country === "MX" ? "MXN" : "COP";
}

/**
 * Suma `months` meses a una fecha y devuelve un ISO date (YYYY-MM-DD) en UTC.
 * Clampa el día si el mes destino es más corto (ej. 31 ene + 1 mes = 28/29 feb).
 */
export function addMonthsIso(from: Date, months: number): string {
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth();
  const d = from.getUTCDate();
  const target = new Date(Date.UTC(y, m + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

/**
 * Diferencia prorrateada a cobrar AHORA en un upgrade.
 *   prorated = round((newMonthly - oldMonthly) * daysLeft / daysInPeriod)
 * Devuelve 0 si no es upgrade (newMonthly <= oldMonthly) o si daysLeft <= 0.
 */
export function prorationCents(args: {
  oldMonthlyCents: number;
  newMonthlyCents: number;
  daysLeft: number;
  daysInPeriod: number;
}): number {
  const { oldMonthlyCents, newMonthlyCents, daysLeft, daysInPeriod } = args;
  if (newMonthlyCents <= oldMonthlyCents) return 0;
  if (daysLeft <= 0 || daysInPeriod <= 0) return 0;
  const clampedDays = Math.min(daysLeft, daysInPeriod);
  return Math.round(((newMonthlyCents - oldMonthlyCents) * clampedDays) / daysInPeriod);
}

/** Días enteros entre dos fechas (b - a), mínimo 0. */
export function daysBetween(a: Date, b: Date): number {
  return Math.max(0, Math.floor((b.getTime() - a.getTime()) / 86_400_000));
}
