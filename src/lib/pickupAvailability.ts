import type { Prisma } from "@prisma/client";

// Bogotá is UTC-5 year-round (no DST), so local HH:MM always maps to
// (HH+5):MM UTC on the same calendar date. That lets us avoid pulling in
// a full tz library just to check "are we inside the lunch window?".
const TZ = "America/Bogota";
const BOGOTA_OFFSET_HOURS = 5;

export const DAY_CODES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type DayCode = (typeof DAY_CODES)[number];

export type PickupWindow = { from: string; to: string }; // "HH:MM", 24h
export type PickupHours = Partial<Record<DayCode, PickupWindow[]>>;

export function parsePickupHours(
  raw: Prisma.JsonValue | null | undefined,
): PickupHours | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const out: PickupHours = {};
  for (const day of DAY_CODES) {
    const arr = src[day];
    if (!Array.isArray(arr)) continue;
    const windows: PickupWindow[] = [];
    for (const w of arr) {
      if (!w || typeof w !== "object") continue;
      const { from, to } = w as Record<string, unknown>;
      if (typeof from !== "string" || typeof to !== "string") continue;
      if (!/^\d{2}:\d{2}$/.test(from) || !/^\d{2}:\d{2}$/.test(to)) continue;
      // Same-day windows only — split across midnight becomes two entries.
      if (from >= to) continue;
      windows.push({ from, to });
    }
    if (windows.length) out[day] = windows;
  }
  return out;
}

function hhmmToMin(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
}

function localNowParts(now: Date): { dayIndex: number; minutes: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hourCycle: "h23",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = fmt.formatToParts(now);
  const wkMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  const wk = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
  const hh = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const mm = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return { dayIndex: wkMap[wk] ?? 0, minutes: hh * 60 + mm };
}

function localDateAt(now: Date, addDays: number, hhmm: string): Date {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const [y, m, d] = ymd.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  return new Date(
    Date.UTC(y, m - 1, d + addDays, hh + BOGOTA_OFFSET_HOURS, mm),
  );
}

export type PickupStatus = {
  open: boolean;
  // When closed, the next local datetime the restaurant reopens. Null when
  // no future window exists within 7 days (e.g. hours object is empty).
  nextOpenAt: Date | null;
};

export function pickupStatus(
  hoursJson: Prisma.JsonValue | null | undefined,
  now: Date = new Date(),
): PickupStatus {
  const hours = parsePickupHours(hoursJson);
  // No schedule configured = always open. Matches behaviour from before the
  // schedule feature existed so pickup doesn't break on upgrade.
  if (!hours) return { open: true, nextOpenAt: null };

  const { dayIndex, minutes } = localNowParts(now);
  const todayWindows = hours[DAY_CODES[dayIndex]] ?? [];
  for (const w of todayWindows) {
    if (minutes >= hhmmToMin(w.from) && minutes < hhmmToMin(w.to)) {
      return { open: true, nextOpenAt: null };
    }
  }

  for (let offset = 0; offset < 7; offset++) {
    const idx = (dayIndex + offset) % 7;
    const wins = (hours[DAY_CODES[idx]] ?? [])
      .slice()
      .sort((a, b) => hhmmToMin(a.from) - hhmmToMin(b.from));
    for (const w of wins) {
      if (offset === 0 && hhmmToMin(w.from) <= minutes) continue;
      return { open: false, nextOpenAt: localDateAt(now, offset, w.from) };
    }
  }
  return { open: false, nextOpenAt: null };
}

export function isWithinEtaCap(
  etaMinutes: number,
  maxEta: number | null | undefined,
): boolean {
  if (!maxEta || maxEta <= 0) return true;
  return etaMinutes <= maxEta;
}

export function formatNextOpening(next: Date): string {
  // Human-readable "hoy 19:00", "mañana 11:00", "lunes 11:00".
  const nowY = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const openY = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(next);
  const time = new Intl.DateTimeFormat("es-CO", {
    timeZone: TZ,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).format(next);
  if (nowY === openY) return `hoy ${time}`;
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const tomY = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(tomorrow);
  if (tomY === openY) return `mañana ${time}`;
  const weekday = new Intl.DateTimeFormat("es-CO", {
    timeZone: TZ,
    weekday: "long",
  }).format(next);
  return `${weekday} ${time}`;
}
