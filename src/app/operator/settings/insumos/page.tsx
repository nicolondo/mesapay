import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { isModuleEnabled, type ModuleSlug } from "@/lib/modules";
import { InsumosClient } from "./InsumosClient";

export const dynamic = "force-dynamic";

// El catálogo de insumos es la base de los tres módulos del track A:
// basta con tener UNO activo para gestionarlo (mismo gate que la API).
const GATE: ModuleSlug[] = ["inventory", "purchasing", "recipes"];

/**
 * Catálogo de insumos (materias primas) del comercio — ERP Fase A0.
 * Solo visible con algún módulo del track A activado; con todo apagado
 * la página no existe (notFound) y la card en settings tampoco aparece.
 */
export default async function InsumosSettingsPage() {
  const t = await getTranslations("opErp");
  const tSettings = await getTranslations("opSettings");
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return <div className="p-6">{tSettings("noRestaurant")}</div>;
  }

  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { enabledModules: true },
  });
  if (!tenant || !GATE.some((m) => isModuleEnabled(tenant.enabledModules, m))) {
    notFound();
  }

  const ingredients = await db.ingredient.findMany({
    where: { restaurantId },
    orderBy: [{ active: "desc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      category: true,
      measureKind: true,
      sku: true,
      notes: true,
      active: true,
      // A4 — punto de reorden editable en el sheet.
      reorderPointBase: true,
      reorderQtyBase: true,
      _count: { select: { supplierItems: true } },
    },
  });

  return (
    <div className="p-6 max-w-3xl mx-auto w-full">
      <Link
        href="/operator/settings"
        className="font-mono text-[11px] tracking-[0.14em] uppercase text-op-muted hover:text-ink"
      >
        {tSettings("backToSettings")}
      </Link>
      <div className="font-display text-3xl mt-2 mb-1">
        {t("insumosTitle")}
      </div>
      <p className="text-sm text-op-muted mb-6">{t("insumosIntro")}</p>

      <InsumosClient initial={ingredients} />
    </div>
  );
}
