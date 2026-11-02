import "server-only";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { resolveInsightsScope, type InsightsScope } from "./scope";
import { resolveAiEnabled } from "./aiAccess";

export type InsightsGate =
  | { ok: true; scope: InsightsScope; userId: string }
  | {
      ok: false;
      error: "forbidden" | "no_restaurant" | "not_found" | "feature_disabled";
      status: 400 | 403 | 404;
    };

/** Roles que ven el panel del operador y, con él, a Pulso. */
const ALLOWED_ROLES = new Set(["operator", "platform_admin", "group_admin"]);

/**
 * Guardia de las rutas del historial de Pulso. Es el mismo gate que aplica
 * el POST de /api/operator/insights/chat: rol con acceso al panel, comercio
 * activo resuelto desde la sesión (nunca del request) y Pulso habilitado
 * para ese comercio. Devuelve códigos de error, nunca texto: el cliente
 * traduce por código.
 */
export async function requireInsightsAccess(): Promise<InsightsGate> {
  const session = await auth();
  const role = session?.user?.role;
  if (!session?.user || !role || !ALLOWED_ROLES.has(role)) {
    return { ok: false, error: "forbidden", status: 403 };
  }
  const scope = await resolveInsightsScope();
  if (!scope) return { ok: false, error: "no_restaurant", status: 400 };

  const r = await db.restaurant.findUnique({
    where: { id: scope.restaurantId },
    select: { plan: true, aiInsightsEnabled: true },
  });
  if (!r) return { ok: false, error: "not_found", status: 404 };
  if (!resolveAiEnabled(r)) return { ok: false, error: "feature_disabled", status: 403 };

  return { ok: true, scope, userId: session.user.id };
}
