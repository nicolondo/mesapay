import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { isModuleEnabled } from "@/lib/modules";
import { DianConfigClient } from "./DianConfigClient";

export const dynamic = "force-dynamic";

/**
 * Configuración de facturación electrónica DIAN (ERP Fase B1.5b): subir el
 * certificado digital, cargar las credenciales del portal DIAN y correr el
 * set de pruebas de habilitación. Gate estricto: SOLO con `einvoicing`
 * activado (mismo gate que la API `/api/operator/dian`). El cliente hace el
 * GET inicial del estado.
 */
export default async function FacturacionDianPage() {
  const t = await getTranslations("opDian");
  const tSettings = await getTranslations("opSettings");
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return <div className="p-6">{tSettings("noRestaurant")}</div>;
  }

  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { enabledModules: true },
  });
  if (!tenant || !isModuleEnabled(tenant.enabledModules, "einvoicing")) {
    notFound();
  }

  return (
    <div className="p-6 max-w-3xl mx-auto w-full">
      <Link
        href="/operator/settings"
        className="font-mono text-[11px] tracking-[0.14em] uppercase text-op-muted hover:text-ink"
      >
        {tSettings("backToSettings")}
      </Link>
      <div className="font-display text-3xl mt-2 mb-1">{t("title")}</div>
      <p className="text-sm text-op-muted mb-6">{t("intro")}</p>

      <DianConfigClient />
    </div>
  );
}
