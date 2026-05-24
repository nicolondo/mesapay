import { db } from "@/lib/db";

/**
 * Multi-menu support.
 *
 * A restaurant always presents at least one "menu" to its diners (the
 * Carta). Wine, cocktail and brunch lists are often physically separate
 * books in real restaurants — extensive enough that mixing them with
 * food creates a wall of options and breaks the price hierarchy. We
 * model that as a first-class `Menu` row that owns categories.
 *
 * Existing data was created before this model existed, so Category.menuId
 * is nullable. ensureDefaultMenu() upserts a default "Carta" for the
 * restaurant and reassigns any null-menuId categories to it — runs
 * idempotently on the read paths that need it.
 */

export const DEFAULT_MENU_LABEL = "Carta";
export const DEFAULT_MENU_SLUG = "carta";

/**
 * Make sure the restaurant has at least one menu, and that no category
 * has a null menuId. Cheap to call (one indexed read + at most one
 * write); routes that surface menu data should call this once.
 */
export async function ensureDefaultMenu(
  restaurantId: string,
): Promise<{ id: string }> {
  let menu = await db.menu.findFirst({
    where: { restaurantId },
    orderBy: { sortOrder: "asc" },
    select: { id: true },
  });
  if (!menu) {
    menu = await db.menu.create({
      data: {
        restaurantId,
        slug: DEFAULT_MENU_SLUG,
        label: DEFAULT_MENU_LABEL,
        sortOrder: 0,
      },
      select: { id: true },
    });
  }
  // Backfill: any pre-existing categories with no menuId get assigned
  // to the first menu (typically the freshly-created default). Idempotent.
  await db.category.updateMany({
    where: { restaurantId, menuId: null },
    data: { menuId: menu.id },
  });
  return menu;
}

/**
 * Normalise a free-text label into a URL-safe, DB-unique slug. Mirrors
 * the slug rule used by category / restaurant slugs elsewhere.
 */
export function slugifyMenu(label: string): string {
  return (
    label
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "menu"
  );
}
