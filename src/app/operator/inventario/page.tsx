import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { loadInventoryStock } from "@/lib/erp/inventoryStock";
import { isModuleEnabled } from "@/lib/modules";
import { InventarioClient } from "./InventarioClient";
import { tabFromParam } from "./types";

export const dynamic = "force-dynamic";

/**
 * Inventario del comercio — ERP Fase A1: existencias valorizadas al costo
 * promedio y el libro de movimientos (entradas, ajustes, mermas). Superficie
 * propia en la nav (operación diaria, no configuración). Gate estricto:
 * SOLO con el módulo `inventory` activado — mismo gate que la API de stock;
 * apagado, la página no existe (notFound) y el item de nav tampoco.
 *
 * `?tab=movimientos|conteos` abre directo esa pestaña (enlaces de la ayuda).
 */
export default async function InventarioPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const tSettings = await getTranslations("opSettings");
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return <div className="p-6">{tSettings("noRestaurant")}</div>;
  }

  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: {
      enabledModules: true,
      country: true,
      inventoryExcludedCategories: true,
    },
  });
  if (!tenant || !isModuleEnabled(tenant.enabledModules, "inventory")) {
    notFound();
  }

  const stock = await loadInventoryStock(restaurantId, tenant.inventoryExcludedCategories);
  // Moneda = país del comercio; el locale solo define idioma/formato
  // (regla idioma ≠ moneda de @/lib/format).
  const currency = await getCurrencyForCountry(tenant.country);
  const tabParam = (await searchParams).tab;

  return (
    <div className="mp-page">
      <InventarioClient
        initial={stock}
        currency={currency}
        initialTab={tabFromParam(typeof tabParam === "string" ? tabParam : null)}
      />
    </div>
  );
}
