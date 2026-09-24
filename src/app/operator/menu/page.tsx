import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { normalizeModifiers } from "@/lib/modifiers";
import { ensureDefaultMenu } from "@/lib/menus";
import { getRestaurantMenuTags } from "@/lib/menuTags";
import { normalizeMenuItemOrder } from "@/lib/menuOrder";
import { MenuEditor } from "./MenuEditor";

export const dynamic = "force-dynamic";

export default async function MenuAdminPage() {
  const t = await getTranslations("opMenuEditor");
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">{t("noRestaurant")}</div>;

  // Make sure the restaurant has a default menu before fetching — also
  // backfills any null menuId on existing categories.
  await ensureDefaultMenu(restaurantId);

  const [menus, categories, items, menuTags, restaurant] = await Promise.all([
    db.menu.findMany({
      where: { restaurantId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true, label: true, slug: true },
    }),
    db.category.findMany({
      where: { restaurantId },
      orderBy: { sortOrder: "asc" },
    }),
    db.menuItem.findMany({
      where: { restaurantId },
      // Mismo desempate que la carta del comensal: en orden manual, dos
      // platos con la misma posición se ven igual acá y allá.
      orderBy: [
        { categoryId: "asc" },
        { sortOrder: "asc" },
        { createdAt: "asc" },
        { id: "asc" },
      ],
    }),
    getRestaurantMenuTags(restaurantId),
    db.restaurant.findUnique({
      where: { id: restaurantId },
      select: { menuItemOrder: true },
    }),
  ]);

  return (
    <MenuEditor
      menus={menus}
      menuItemOrder={normalizeMenuItemOrder(restaurant?.menuItemOrder)}
      menuTags={menuTags}
      categories={categories.map((c) => ({
        id: c.id,
        label: c.label,
        slug: c.slug,
        kind: c.kind,
        prepStation: c.prepStation,
        // Null shouldn't happen after ensureDefaultMenu, but be safe.
        menuId: c.menuId ?? menus[0]?.id ?? "",
        parentId: c.parentId ?? null,
        sortOrder: c.sortOrder,
      }))}
      items={items.map((i) => ({
        id: i.id,
        categoryId: i.categoryId,
        name: i.name,
        description: i.description ?? "",
        priceCents: i.priceCents,
        available: i.available,
        trackInventory: i.trackInventory,
        photoUrl: i.photoUrl ?? null,
        tags: i.tags,
        // Normalise legacy `opts: string[]` to the new object form so
        // the editor only deals with one shape. Bad / missing entries
        // are dropped.
        modifiers: normalizeModifiers(i.modifiers),
        prepMinutes: i.prepMinutes,
        prepStation: i.prepStation,
        sortOrder: i.sortOrder,
      }))}
    />
  );
}

// (ModifierDef shape now defined inline in MenuEditor.tsx — this page
// passes the normalised array straight through.)
