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

export function bogotaDayRange(isoDate: string): { start: Date; end: Date } {
  const [y, m, d] = isoDate.split("-").map(Number);
  if (!y || !m || !d) throw new Error("invalid date");
  // Bogota midnight = UTC 05:00 that same calendar day.
  const start = new Date(Date.UTC(y, m - 1, d, 5, 0, 0, 0));
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
