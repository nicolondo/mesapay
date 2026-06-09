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

/**
 * ¿Cuántos mensajes de usuario ya gastó hoy este comercio? (zona UTC del server;
 * suficiente para un límite operativo). Cuenta AiMessage role="user" del día.
 */
export async function messagesUsedToday(restaurantId: string): Promise<number> {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return db.aiMessage.count({
    where: {
      role: "user",
      createdAt: { gte: start },
      conversation: { restaurantId },
    },
  });
}
