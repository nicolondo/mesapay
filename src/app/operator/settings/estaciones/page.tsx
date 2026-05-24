import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { StationsClient } from "./StationsClient";

export const dynamic = "force-dynamic";

export default async function StationsSettingsPage() {
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">Sin restaurante.</div>;

  const [tenant, categories] = await Promise.all([
    db.restaurant.findUnique({
      where: { id: restaurantId },
      select: {
        hasBar: true,
        name: true,
        barSubStations: true,
        kitchenPrintEnabled: true,
        barPrintEnabled: true,
        printPaperWidthMm: true,
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
      },
    }),
  ]);
  if (!tenant) return <div className="p-6">Restaurante no encontrado.</div>;

  return (
    <StationsClient
      hasBar={tenant.hasBar}
      barSubStations={tenant.barSubStations}
      kitchenPrintEnabled={tenant.kitchenPrintEnabled}
      barPrintEnabled={tenant.barPrintEnabled}
      printPaperWidthMm={tenant.printPaperWidthMm as 58 | 80}
      categories={categories.map((c) => ({
        id: c.id,
        label: c.label,
        slug: c.slug,
        kind: c.kind,
        prepStation: c.prepStation,
        barSubStation: c.barSubStation,
      }))}
    />
  );
}
