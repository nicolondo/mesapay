import { db } from "@/lib/db";

const AI_PLANS = new Set(["trial", "pro"]); // basic (Esencial) queda fuera

export function isAiEnabledForPlan(plan: string): boolean {
  return AI_PLANS.has(plan);
}

/** Override por comercio gana al plan. null = según plan. */
export function resolveAiEnabled(r: {
  plan: string;
  aiInsightsEnabled: boolean | null;
}): boolean {
  if (r.aiInsightsEnabled === true) return true;
  if (r.aiInsightsEnabled === false) return false;
  return isAiEnabledForPlan(r.plan);
}

/** Límite diario efectivo (override del comercio o default global). */
export async function dailyMessageLimit(
  restaurantDailyLimit: number | null,
): Promise<number> {
  if (typeof restaurantDailyLimit === "number") return restaurantDailyLimit;
  const cfg = await db.platformConfig.findUnique({ where: { id: "singleton" } });
  return cfg?.aiDailyMessageLimit ?? 50;
}

/** Partes de fecha y hora de `at` en `timeZone`. */
function zonedParts(at: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { y: get("year"), m: get("month"), d: get("day"), hh: get("hour"), mi: get("minute"), ss: get("second") };
}

/** "YYYY-MM-DD" de `at` en la zona del comercio (no la del servidor). */
export function localIsoDate(at: Date, timeZone: string): string {
  const { y, m, d } = zonedParts(at, timeZone);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Instante de la medianoche de HOY en la zona del comercio. Antes se usaba
 * la medianoche del servidor (UTC): el límite diario de Pulso se reiniciaba
 * a las 7 p. m. de Colombia.
 */
export function startOfLocalDay(now: Date, timeZone: string): Date {
  const p = zonedParts(now, timeZone);
  // Desfase de la zona en este instante (sin segundos sueltos de redondeo).
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mi, p.ss);
  const offsetMs = Math.round((asUtc - now.getTime()) / 60_000) * 60_000;
  return new Date(Date.UTC(p.y, p.m - 1, p.d) - offsetMs);
}

/**
 * ¿Cuántos mensajes de usuario ya gastó hoy este comercio? «Hoy» es el día
 * de la zona del comercio (Bogotá por defecto), de medianoche a medianoche.
 * Cuenta AiMessage role="user" del día.
 */
export async function messagesUsedToday(
  restaurantId: string,
  opts: { timeZone?: string; now?: Date } = {},
): Promise<number> {
  const start = startOfLocalDay(opts.now ?? new Date(), opts.timeZone ?? "America/Bogota");
  return db.aiMessage.count({
    where: {
      role: "user",
      createdAt: { gte: start },
      conversation: { restaurantId },
    },
  });
}
