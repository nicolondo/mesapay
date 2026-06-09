import { getActiveRestaurantId } from "@/lib/activeRestaurant";

export type InsightsScope = {
  kind: "restaurant";
  restaurantId: string;
};

/**
 * Resuelve el scope del asistente desde la sesión del operador. NUNCA confía en
 * input del cliente/modelo. Devuelve null si no hay restaurante activo.
 */
export async function resolveInsightsScope(): Promise<InsightsScope | null> {
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return null;
  return { kind: "restaurant", restaurantId };
}
