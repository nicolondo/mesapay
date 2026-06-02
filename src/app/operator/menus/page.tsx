import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { ensureDefaultMenu } from "@/lib/menus";
import { MenusClient } from "./MenusClient";

export const dynamic = "force-dynamic";

/**
 * Menu manager. A "menu" is a top-level grouping (Carta, Vinos,
 * Bebidas, Brunch…) that owns categories. Every restaurant has at
 * least one — the default Carta — and additional menus surface as
 * tabs on the diner's view.
 */
export default async function MenusPage() {
  const t = await getTranslations("opMenus");
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">{t("noRestaurant")}</div>;

  // Lazy-create the default Carta on first visit so the operator sees
  // at least one row instead of an empty page.
  await ensureDefaultMenu(restaurantId);

  const menus = await db.menu.findMany({
    where: { restaurantId },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      slug: true,
      label: true,
      description: true,
      sortOrder: true,
      _count: { select: { categories: true } },
    },
  });

  return (
    <MenusClient
      menus={menus.map((m) => ({
        id: m.id,
        slug: m.slug,
        label: m.label,
        description: m.description,
        sortOrder: m.sortOrder,
        categoryCount: m._count.categories,
      }))}
    />
  );
}
