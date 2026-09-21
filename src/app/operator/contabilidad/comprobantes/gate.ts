import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { isModuleEnabled } from "@/lib/modules";

/**
 * Gate compartido de las páginas de comprobantes: mismo criterio que
 * `contabilidad/page.tsx` — sin restaurante activo se avisa; con el módulo
 * `accounting` apagado la página no existe (notFound). Devuelve la moneda
 * del comercio (país), que es lo único que la UI necesita del servidor.
 */
export async function loadComprobantesContext(): Promise<
  { currency: string } | "no_restaurant"
> {
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return "no_restaurant";
  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { enabledModules: true, country: true },
  });
  if (!tenant || !isModuleEnabled(tenant.enabledModules, "accounting")) {
    notFound();
  }
  return { currency: await getCurrencyForCountry(tenant.country) };
}
