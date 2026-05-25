import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { ensureDefaultMenu } from "@/lib/menus";
import { getRestaurantMenuTags } from "@/lib/menuTags";
import { MenuImportClient } from "./MenuImportClient";

export const dynamic = "force-dynamic";

export default async function MenuImportPage({
  searchParams,
}: {
  // The "Importar con AI" button on the menu editor passes the active
  // tab's menu id here so we can default-target the right carta.
  searchParams: Promise<{ menu?: string }>;
}) {
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">Sin restaurante.</div>;
  const sp = await searchParams;

  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { name: true, slug: true },
  });
  if (!tenant) return <div className="p-6">Restaurante no encontrado.</div>;

  // Make sure the restaurant has at least one menu so the import flow
  // always has a valid target.
  await ensureDefaultMenu(restaurantId);

  const [existingCategories, menus, menuTags] = await Promise.all([
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
    getRestaurantMenuTags(restaurantId),
  ]);

  // Honour the requested menu only if it actually belongs to this
  // restaurant; otherwise fall back to the first menu (the default
  // Carta) so a stale URL never lands dishes in the wrong tenant.
  const requestedMenuId =
    sp.menu && menus.some((m) => m.id === sp.menu) ? sp.menu : null;

  return (
    <MenuImportClient
      tenantName={tenant.name}
      initialCategories={existingCategories}
      menus={menus}
      initialMenuId={requestedMenuId}
      menuTags={menuTags}
    />
  );
}
