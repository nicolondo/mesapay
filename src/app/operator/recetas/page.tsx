import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { isModuleEnabled } from "@/lib/modules";
import { RecetasClient } from "./RecetasClient";

export const dynamic = "force-dynamic";

/**
 * Recetas del comercio — ERP Fase A3: receta por plato con food cost EN
 * VIVO (costo real del inventario), margen contra el precio de carta y,
 * más adelante, sub-recetas e ingeniería de menú. Superficie propia en la
 * nav (patrón inventario/compras). Gate estricto: SOLO con el módulo
 * `recipes` activado — mismo gate que la API de recipes; apagado, la
 * página no existe (notFound) y el item de nav tampoco.
 *
 * A diferencia de compras no se precarga server-side: el payload requiere
 * el pipeline de costeo (cascada D3) que ya vive en GET /api/operator/
 * recipes — el client hace el fetch inicial al montar.
 */
export default async function RecetasPage() {
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
  if (!tenant || !isModuleEnabled(tenant.enabledModules, "recipes")) {
    notFound();
  }

  // Moneda = país del comercio; el locale solo define idioma/formato
  // (regla idioma ≠ moneda de @/lib/format).
  const currency = await getCurrencyForCountry(tenant.country);

  return (
    <div className="p-6 max-w-3xl mx-auto w-full">
      <div className="font-display text-3xl mb-1">{t("recetasTitle")}</div>
      <p className="text-sm text-op-muted mb-6">{t("recetasIntro")}</p>

      <RecetasClient currency={currency} />
    </div>
  );
}
