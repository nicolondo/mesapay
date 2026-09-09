import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { resolveEnabledModules, type ModuleSlug } from "@/lib/modules";

/**
 * Guard compartido de las rutas API del ERP: auth (operator/platform_admin)
 * + restaurante activo + gate de módulo server-side (defensa en profundidad:
 * la UI ya oculta las superficies con el módulo apagado, pero la API
 * igual rechaza con 403 module_disabled).
 *
 * `anyOf`: basta con que UNO de los módulos esté activo — p.ej. el catálogo
 * de insumos es visible con inventory O purchasing O recipes. Lista VACÍA
 * = sin gate de módulo (sólo auth + restaurante activo), para superficies
 * que todo comercio necesita aunque no haya comprado ningún módulo — hoy,
 * la resolución de numeración, que manda el consecutivo del comprobante
 * impreso.
 */
export type ErpContext = { restaurantId: string; country: string | null };
export type ErpDenied = { error: string; status: number };

export async function getErpContext(
  anyOf: ModuleSlug[],
): Promise<ErpContext | ErpDenied> {
  const session = await auth();
  const role = session?.user?.role;
  if (role !== "operator" && role !== "platform_admin" && role !== "group_admin") {
    return { error: "unauthorized", status: 401 };
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return { error: "no_restaurant", status: 400 };
  }
  const r = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { enabledModules: true, country: true },
  });
  if (!r) return { error: "no_restaurant", status: 400 };
  const enabled = resolveEnabledModules(r.enabledModules);
  if (anyOf.length > 0 && !anyOf.some((m) => enabled.includes(m))) {
    return { error: "module_disabled", status: 403 };
  }
  return { restaurantId, country: r.country };
}

export function isDenied(ctx: ErpContext | ErpDenied): ctx is ErpDenied {
  return "error" in ctx;
}
