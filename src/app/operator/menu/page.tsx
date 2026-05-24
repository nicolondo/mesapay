import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { normalizeModifiers } from "@/lib/modifiers";
import { ensureDefaultMenu } from "@/lib/menus";
import { MenuEditor } from "./MenuEditor";

export const dynamic = "force-dynamic";

export default async function MenuAdminPage() {
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">Sin restaurante.</div>;

  // Make sure the restaurant has a default menu before fetching — also
  // backfills any null menuId on existing categories.
  await ensureDefaultMenu(restaurantId);

  const [menus, categories, items] = await Promise.all([
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
      orderBy: [{ categoryId: "asc" }, { sortOrder: "asc" }],
    }),
  ]);

  return (
    <MenuEditor
      menus={menus}
      categories={categories.map((c) => ({
        id: c.id,
        label: c.label,
        slug: c.slug,
        kind: c.kind,
        prepStation: c.prepStation,
        // Null shouldn't happen after ensureDefaultMenu, but be safe.
        menuId: c.menuId ?? menus[0]?.id ?? "",
      }))}
      items={items.map((i) => ({
        id: i.id,
        categoryId: i.categoryId,
        name: i.name,
        description: i.description ?? "",
        priceCents: i.priceCents,
        available: i.available,
        photoUrl: i.photoUrl ?? null,
        tags: i.tags,
        // Normalise legacy `opts: string[]` to the new object form so
        // the editor only deals with one shape. Bad / missing entries
        // are dropped.
        modifiers: normalizeModifiers(i.modifiers),
        prepMinutes: i.prepMinutes,
        prepStation: i.prepStation,
      }))}
    />
  );
}

// (ModifierDef shape now defined inline in MenuEditor.tsx — this page
// passes the normalised array straight through.)
