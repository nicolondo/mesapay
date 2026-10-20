// America/Bogota is UTC−5 year-round (no DST).
// We compute day ranges with this fixed offset so reports line up with the
// calendar day the restaurant experiences, not the server's UTC day.

const OFFSET_MS = -5 * 60 * 60 * 1000;

export function bogotaTodayIso(): string {
  const now = new Date();
  const b = new Date(now.getTime() + OFFSET_MS);
  const y = b.getUTCFullYear();
  const m = String(b.getUTCMonth() + 1).padStart(2, "0");
  const d = String(b.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Fecha contable de "ahora", con hora de corte del día (`cutoffHour`,
 * en hora Bogotá, 0–23). Para restaurantes que cierran de madrugada:
 * con corte = 5, todo lo de 00:00–05:00 cuenta como el día anterior.
 * cutoffHour = 0 → idéntico a bogotaTodayIso (medianoche).
 */
export function bogotaBusinessTodayIso(cutoffHour = 0): string {
  return bogotaBusinessDateIso(new Date(), cutoffHour);
}

/** Fecha contable de un instante, independiente de la zona del servidor. */
export function bogotaBusinessDateIso(at: Date, cutoffHour = 0): string {
  // Restamos el corte: si aún no llegó la hora de corte, caemos al día
  // anterior.
  const b = new Date(at.getTime() + OFFSET_MS - cutoffHour * 60 * 60 * 1000);
  const y = b.getUTCFullYear();
  const m = String(b.getUTCMonth() + 1).padStart(2, "0");
  const d = String(b.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * La jornada persistida es un DATE, representado por Prisma a medianoche UTC.
 * No se convierte a Bogotá: hacerlo restaría otro día. El fallback mantiene
 * compatibles modelos históricos sin el campo; nunca usa la hora de cierre.
 */
export function shiftBusinessDateIso(
  shift: { businessDate?: Date | null; openedAt: Date },
  cutoffHour = 0,
): string {
  return shift.businessDate?.toISOString().slice(0, 10)
    ?? bogotaBusinessDateIso(shift.openedAt, cutoffHour);
}

/**
 * Rango [start, end) del día contable `isoDate`. Con `cutoffHour` el
 * día arranca a esa hora Bogotá (ej. corte 5 → "17" = 17 05:00 a 18
 * 05:00). cutoffHour = 0 = medianoche (comportamiento histórico).
 */
export function bogotaDayRange(
  isoDate: string,
  cutoffHour = 0,
): { start: Date; end: Date } {
  const [y, m, d] = isoDate.split("-").map(Number);
  if (!y || !m || !d) throw new Error("invalid date");
  // Bogota midnight = UTC 05:00 that same calendar day; sumamos el corte.
  const start = new Date(Date.UTC(y, m - 1, d, 5 + cutoffHour, 0, 0, 0));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

export function fmtBogotaDateTime(d: Date): { date: string; time: string } {
  const b = new Date(d.getTime() + OFFSET_MS);
  const yy = b.getUTCFullYear();
  const mm = String(b.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(b.getUTCDate()).padStart(2, "0");
  const hh = String(b.getUTCHours()).padStart(2, "0");
  const mi = String(b.getUTCMinutes()).padStart(2, "0");
  return { date: `${yy}-${mm}-${dd}`, time: `${hh}:${mi}` };
}

export function addDaysIso(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}
