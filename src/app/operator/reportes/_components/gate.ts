import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { isModuleEnabled } from "@/lib/modules";

/**
 * Gate de las páginas de reportes: mismo patrón que
 * `operator/contabilidad/page.tsx`. Sin restaurante activo → null (la
 * página muestra `opSettings.noRestaurant`); con el módulo `accounting`
 * apagado → `notFound()`: la página no existe. Devuelve también lo que
 * todo reporte necesita: moneda (= país del comercio) y encabezado legal.
 */
export async function reportGate(): Promise<{
  restaurantId: string;
  currency: string;
  business: { name: string; taxId: string | null };
} | null> {
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return null;
  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { enabledModules: true, country: true, name: true, legalName: true, taxId: true },
  });
  if (!tenant || !isModuleEnabled(tenant.enabledModules, "accounting")) {
    notFound();
  }
  const currency = await getCurrencyForCountry(tenant.country);
  return {
    restaurantId,
    currency,
    business: { name: tenant.legalName ?? tenant.name, taxId: tenant.taxId },
  };
}

/** `searchParams` de Next (Promise de string | string[]) → primer valor plano. */
export function firstParam(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
