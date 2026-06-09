export type LocalParts = { dateKey: string; hour: number; dow: number; weekday: string };

const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function localParts(d: Date, timeZone: string): LocalParts {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hour12: false, weekday: "short",
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const year = get("year"), month = get("month"), day = get("day");
  let hour = parseInt(get("hour"), 10);
  if (hour === 24) hour = 0; // algunos runtimes devuelven 24
  const weekday = get("weekday");
  return { dateKey: `${year}-${month}-${day}`, hour, dow: WD[weekday] ?? 0, weekday };
}

export function dateKeyInTz(d: Date, timeZone: string, bucket: "day" | "week" | "month"): string {
  const p = localParts(d, timeZone);
  if (bucket === "month") return p.dateKey.slice(0, 7);
  if (bucket === "day") return p.dateKey;
  // week: retroceder al lunes
  const [y, m, dd] = p.dateKey.split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1, dd));
  const isoDow = p.dow === 0 ? 7 : p.dow; // 1..7, lunes=1
  base.setUTCDate(base.getUTCDate() - (isoDow - 1));
  return base.toISOString().slice(0, 10);
}
