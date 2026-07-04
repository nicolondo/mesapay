import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { isModuleEnabled } from "@/lib/modules";
import { ProveedoresClient } from "./ProveedoresClient";

export const dynamic = "force-dynamic";

/**
 * Proveedores del comercio (ERP Fase A0): contactos, condiciones de pago y
 * lista de precios por proveedor. Gate estricto: SOLO con `purchasing`
 * activado (a diferencia de insumos, que abre con cualquier módulo del
 * track A) — mismo gate que la API de suppliers.
 */
export default async function ProveedoresSettingsPage() {
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
  if (!tenant || !isModuleEnabled(tenant.enabledModules, "purchasing")) {
    notFound();
  }

  const suppliers = await db.supplier.findMany({
    where: { restaurantId },
    orderBy: [{ active: "desc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      taxId: true,
      contactName: true,
      phone: true,
      email: true,
      address: true,
      paymentTermsDays: true,
      notes: true,
      active: true,
      _count: { select: { items: true } },
    },
  });

  // Moneda de la lista de precios = país del comercio; el locale solo
  // define idioma/formato (regla idioma ≠ moneda de @/lib/format).
  const currency = await getCurrencyForCountry(tenant.country);

  return (
    <div className="p-6 max-w-3xl mx-auto w-full">
      <Link
        href="/operator/settings"
        className="font-mono text-[11px] tracking-[0.14em] uppercase text-op-muted hover:text-ink"
      >
        {tSettings("backToSettings")}
      </Link>
      <div className="font-display text-3xl mt-2 mb-1">
        {t("proveedoresTitle")}
      </div>
      <p className="text-sm text-op-muted mb-6">{t("proveedoresIntro")}</p>

      <ProveedoresClient initial={suppliers} currency={currency} />
    </div>
  );
}
