import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { isModuleEnabled } from "@/lib/modules";
import { InventarioClient } from "./InventarioClient";

export const dynamic = "force-dynamic";

/**
 * Inventario del comercio — ERP Fase A1: existencias valorizadas al costo
 * promedio y el libro de movimientos (entradas, ajustes, mermas). Superficie
 * propia en la nav (operación diaria, no configuración). Gate estricto:
 * SOLO con el módulo `inventory` activado — mismo gate que la API de stock;
 * apagado, la página no existe (notFound) y el item de nav tampoco.
 */
export default async function InventarioPage() {
  const t = await getTranslations("opErp");
  const tSettings = await getTranslations("opSettings");
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return <div className="p-6">{tSettings("noRestaurant")}</div>;
  }

  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { enabledModules: true, country: true },
  });
  if (!tenant || !isModuleEnabled(tenant.enabledModules, "inventory")) {
    notFound();
  }

  // Mismo criterio que GET /api/operator/stock: se lista desde el INSUMO
  // para incluir activos sin movimientos (level null → 0); los inactivos
  // solo si conservan saldo ≠ 0 (siguen siendo plata en la bodega).
  const ingredients = await db.ingredient.findMany({
    where: { restaurantId },
    orderBy: [{ active: "desc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      category: true,
      measureKind: true,
      active: true,
      // A4 — la UI marca "bajo mínimo" con qtyBase <= reorderPointBase.
      reorderPointBase: true,
      reorderQtyBase: true,
      stockLevel: {
        select: { qtyBase: true, totalValueCents: true, updatedAt: true },
      },
    },
  });
  const stock = ingredients.filter(
    (i) => i.active || (i.stockLevel && i.stockLevel.qtyBase !== 0),
  );

  // Moneda = país del comercio; el locale solo define idioma/formato
  // (regla idioma ≠ moneda de @/lib/format).
  const currency = await getCurrencyForCountry(tenant.country);

  return (
    <div className="p-6 max-w-3xl mx-auto w-full">
      <div className="font-display text-3xl mb-1">{t("inventarioTitle")}</div>
      <p className="text-sm text-op-muted mb-6">{t("inventarioIntro")}</p>

      <InventarioClient initial={stock} currency={currency} />
    </div>
  );
}
