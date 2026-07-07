import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { isModuleEnabled } from "@/lib/modules";
import { ContabilidadClient } from "./ContabilidadClient";

export const dynamic = "force-dynamic";

/**
 * Contabilidad del comercio — ERP Fase B2: gastos (con recurrentes tipo
 * arriendo/nómina), P&L mensual y libros de ventas/compras exportables.
 * Superficie propia en la nav (patrón inventario/compras/recetas). Gate
 * estricto: SOLO con el módulo `accounting` activado — mismo gate que la
 * API de expenses; apagado, la página no existe (notFound) y el item de
 * nav tampoco.
 *
 * No se precarga server-side: el payload depende del mes seleccionado y
 * ya vive en los GET de /api/operator (expenses, accounting/pnl,
 * accounting/books) — el client hace fetch al montar y al cambiar de
 * mes/tab, con caché por mes.
 */
export default async function ContabilidadPage() {
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
  if (!tenant || !isModuleEnabled(tenant.enabledModules, "accounting")) {
    notFound();
  }

  // Moneda = país del comercio; el locale solo define idioma/formato
  // (regla idioma ≠ moneda de @/lib/format).
  const currency = await getCurrencyForCountry(tenant.country);

  return (
    <div className="p-6 max-w-3xl mx-auto w-full">
      <div className="font-display text-3xl mb-1">{t("accountingTitle")}</div>
      <p className="text-sm text-op-muted mb-6">{t("accountingIntro")}</p>

      <ContabilidadClient currency={currency} />
    </div>
  );
}
