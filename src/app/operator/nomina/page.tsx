import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { isModuleEnabled } from "@/lib/modules";
import { NominaClient } from "./NominaClient";

export const dynamic = "force-dynamic";

/**
 * Nómina — liquidación mensual legal (portada de zenith-erp): salario +
 * recargos de Horarios + auxilio, deducciones (salud/pensión), aportes del
 * empleador (ARL, caja, ICBF, SENA) y provisiones (cesantías, prima,
 * vacaciones), parametrizada por comercio. Gate: módulo staff.
 */
export default async function NominaPage() {
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
  const currency = await getCurrencyForCountry(tenant.country);
  return (
    <div className="p-4 lg:p-6 max-w-3xl mx-auto w-full">
      <NominaClient currency={currency} />
    </div>
  );
}
