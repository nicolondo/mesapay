import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { MenuImportClient } from "./MenuImportClient";

export const dynamic = "force-dynamic";

export default async function MenuImportPage() {
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">Sin restaurante.</div>;

  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { name: true, slug: true },
  });
  if (!tenant) return <div className="p-6">Restaurante no encontrado.</div>;

  const existingCategories = await db.category.findMany({
    where: { restaurantId },
    orderBy: { sortOrder: "asc" },
    select: { id: true, slug: true, label: true, kind: true },
  });

  return (
    <MenuImportClient
      tenantName={tenant.name}
      initialCategories={existingCategories}
    />
  );
}
