import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { StationsClient } from "./StationsClient";

export const dynamic = "force-dynamic";

export default async function StationsSettingsPage() {
  const t = await getTranslations("opStations");
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">{t("noRestaurant")}</div>;

  const [tenant, categories, menus, printers] = await Promise.all([
    db.restaurant.findUnique({
      where: { id: restaurantId },
      select: {
        hasBar: true,
        name: true,
        barSubStations: true,
        kitchenPrintEnabled: true,
        barPrintEnabled: true,
        printPaperWidthMm: true,
        kitchenAutoFire: true,
        barAutoFire: true,
      },
    }),
    db.category.findMany({
      where: { restaurantId },
      orderBy: { sortOrder: "asc" },
      select: {
        id: true,
        label: true,
        slug: true,
        kind: true,
        prepStation: true,
        barSubStation: true,
        menuId: true,
      },
    }),
    db.menu.findMany({
      where: { restaurantId },
      orderBy: { sortOrder: "asc" },
      select: { id: true, label: true },
    }),
    // Para avisar, al lado de cada toggle de impresión, si hay alguna
    // impresora de red que de verdad vaya a recibir la comanda. Es la
    // misma lista que mira `enqueueRoundTicket`.
    db.printer.findMany({
      where: { restaurantId },
      select: { kind: true, station: true, barSubStation: true, active: true },
    }),
  ]);
  if (!tenant) return <div className="p-6">{t("restaurantNotFound")}</div>;

  return (
    <StationsClient
      hasBar={tenant.hasBar}
      barSubStations={tenant.barSubStations}
      kitchenPrintEnabled={tenant.kitchenPrintEnabled}
      barPrintEnabled={tenant.barPrintEnabled}
      printPaperWidthMm={tenant.printPaperWidthMm as 58 | 80}
      kitchenAutoFire={tenant.kitchenAutoFire}
      barAutoFire={tenant.barAutoFire}
      printers={printers}
      menus={menus}
      categories={categories.map((c) => ({
        id: c.id,
        label: c.label,
        slug: c.slug,
        kind: c.kind,
        prepStation: c.prepStation,
        barSubStation: c.barSubStation,
        menuId: c.menuId,
      }))}
    />
  );
}
