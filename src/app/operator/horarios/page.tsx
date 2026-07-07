import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { isModuleEnabled } from "@/lib/modules";
import { HorariosClient } from "./HorariosClient";

export const dynamic = "force-dynamic";

/**
 * Horarios del equipo — ERP Fase C1: planeación semanal de turnos,
 * asistencia (entró/salió) y CRUD de empleados con tarifa por hora.
 * Superficie propia en la nav (patrón contabilidad/producción). Gate
 * estricto: SOLO con el módulo `staff` activado — mismo gate que las
 * APIs de employees/staff-shifts; apagado, la página no existe
 * (notFound) y el item de nav tampoco.
 *
 * Turnos y equipo se cargan client-side (dependen de la semana/tab —
 * mismo criterio que contabilidad). Lo único que sí se precarga acá es
 * la lista de usuarios del comercio para el select opcional "usuario del
 * app" del empleado: no existe un GET simple de usuarios y la lista es
 * chica y estable (patrón settings/usuarios).
 */
export default async function HorariosPage() {
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
  if (!tenant || !isModuleEnabled(tenant.enabledModules, "staff")) {
    notFound();
  }

  // Moneda = país del comercio; el locale solo define idioma/formato
  // (regla idioma ≠ moneda de @/lib/format).
  const currency = await getCurrencyForCountry(tenant.country);

  // Usuarios staff del comercio (mismos roles que settings/usuarios —
  // customer y platform_admin no se gestionan desde el panel). Solo lo
  // que el select necesita para rotular.
  const users = await db.user.findMany({
    where: {
      restaurantId,
      role: { in: ["operator", "mesero", "kitchen", "bar", "terminal"] },
    },
    orderBy: [{ role: "asc" }, { createdAt: "asc" }],
    select: { id: true, email: true, name: true },
  });

  return (
    <div className="p-6 max-w-3xl mx-auto w-full">
      <div className="font-display text-3xl mb-1">{t("staffTitle")}</div>
      <p className="text-sm text-op-muted mb-6">{t("staffIntro")}</p>

      <HorariosClient currency={currency} users={users} />
    </div>
  );
}
