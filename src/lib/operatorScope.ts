import "server-only";
import { auth } from "@/auth";
import { getActiveRestaurantId } from "./activeRestaurant";

/**
 * Guardia común de las rutas de operador: exige un rol de staff y devuelve
 * el restaurante activo.
 *
 * Existe para que el `restaurantId` con el que se consultan datos SIEMPRE
 * venga de la sesión (o de la cookie de impersonación ya validada en
 * `getActiveContext`) y nunca del cuerpo del request. Es la pieza que
 * sostiene la regla del feature de cuentas de comensal: la identidad del
 * comensal es global, pero lo que un restaurante puede VER de esa persona
 * se limita a lo que pasó en su propio local.
 */
export type OperatorScope = {
  restaurantId: string;
  role: string;
  userId: string;
};

const STAFF_ROLES = new Set([
  "operator",
  "platform_admin",
  "group_admin",
  "mesero",
]);

export async function requireOperatorScope(
  allowed: readonly string[] = [...STAFF_ROLES],
): Promise<OperatorScope | { error: "forbidden" | "no_restaurant" }> {
  const session = await auth();
  const role = session?.user?.role;
  if (!session?.user || !role || !allowed.includes(role)) {
    return { error: "forbidden" };
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return { error: "no_restaurant" };
  return { restaurantId, role, userId: session.user.id };
}

export function isScopeError(
  v: OperatorScope | { error: string },
): v is { error: "forbidden" | "no_restaurant" } {
  return "error" in v;
}
