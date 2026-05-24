import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { ensureDefaultMenu } from "@/lib/menus";
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

  // Make sure the restaurant has at least one menu so the import flow
  // always has a valid target.
  await ensureDefaultMenu(restaurantId);

  const [existingCategories, menus] = await Promise.all([
    db.category.findMany({
      where: { restaurantId },
      orderBy: { sortOrder: "asc" },
      select: { id: true, slug: true, label: true, kind: true },
    }),
    db.menu.findMany({
      where: { restaurantId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true, label: true, slug: true },
    }),
  ]);

  return (
    <MenuImportClient
      tenantName={tenant.name}
      initialCategories={existingCategories}
      menus={menus}
    />
  );
}
