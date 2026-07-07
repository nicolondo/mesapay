import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { isModuleEnabled } from "@/lib/modules";
import { ProduccionClient } from "./ProduccionClient";

export const dynamic = "force-dynamic";

/**
 * Producción de batches — ERP Fase A5: producir una sub-receta mueve
 * inventario de verdad (salen los insumos valorados al promedio actual,
 * entra el elaborado con el costo exacto de lo que salió). Superficie
 * propia en la nav (patrón contabilidad). Gate estricto: SOLO con el
 * módulo `production` activado — mismo gate que la API; apagado, la
 * página no existe (notFound) y el item de nav tampoco.
 *
 * No se precarga server-side: el historial, las sub-recetas y los
 * promedios ya viven en los GET de /api/operator (production, recipes,
 * stock) — el client hace fetch al montar y refresca tras cada batch.
 */
export default async function ProduccionPage() {
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
  if (!tenant || !isModuleEnabled(tenant.enabledModules, "production")) {
    notFound();
  }

  // Moneda = país del comercio; el locale solo define idioma/formato
  // (regla idioma ≠ moneda de @/lib/format).
  const currency = await getCurrencyForCountry(tenant.country);

  return (
    <div className="p-6 max-w-3xl mx-auto w-full">
      <div className="font-display text-3xl mb-1">{t("productionTitle")}</div>
      <p className="text-sm text-op-muted mb-6">{t("productionIntro")}</p>

      <ProduccionClient currency={currency} />
    </div>
  );
}
