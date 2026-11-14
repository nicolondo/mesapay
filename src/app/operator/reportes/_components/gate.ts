import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { resolveEnabledModules, type ModuleSlug } from "@/lib/modules";

/**
 * Gate de las páginas de reportes: mismo patrón que
 * `operator/contabilidad/page.tsx`. Sin restaurante activo → null (la
 * página muestra `opSettings.noRestaurant`); con el módulo `accounting`
 * apagado → `notFound()`: la página no existe. Devuelve también lo que
 * todo reporte necesita: moneda (= país del comercio) y encabezado legal.
 *
 * `anyOf`: módulos que abren la página (basta uno). Por defecto sólo
 * `accounting`; el informe de proveedores abre también con `purchasing`.
 */
export async function reportGate(anyOf: readonly ModuleSlug[] = ["accounting"]): Promise<{
  restaurantId: string;
  currency: string;
  /** ISO-2 del comercio («CO» activa la cascada colombiana del estado de resultado). */
  country: string | null;
  business: { name: string; taxId: string | null };
  /** Módulos activos del comercio (para enlaces que dependen de otro módulo). */
  modules: ModuleSlug[];
} | null> {
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return null;
  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { enabledModules: true, country: true, name: true, legalName: true, taxId: true },
  });
  const modules = resolveEnabledModules(tenant?.enabledModules);
  if (!tenant || !anyOf.some((m) => modules.includes(m))) {
    notFound();
  }
  const currency = await getCurrencyForCountry(tenant.country);
  return {
    restaurantId,
    currency,
    country: tenant.country,
    business: { name: tenant.legalName ?? tenant.name, taxId: tenant.taxId },
    modules,
  };
}

/** `searchParams` de Next (Promise de string | string[]) → primer valor plano. */
export function firstParam(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
