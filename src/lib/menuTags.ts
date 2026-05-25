// Menu tags ("etiquetas" del plato) — configurable por restaurante.
//
// Vivían como una lista hardcoded de 5 valores (firma / popular / veg
// / spicy / nuevo). Ahora cada Restaurant puede tener su propia lista
// en `Restaurant.menuTags` (Json). Cuando es null tomamos los defaults
// — restaurantes existentes no notan el cambio.
//
// MenuItem.tags sigue siendo String[] de slugs; el "registro" del
// restaurante solo lleva slug → label/emoji para renderizar. Si un
// operador borra una etiqueta de su registro, los items que la
// referenciaban siguen funcionando pero esa tag deja de aparecer en la
// UI (no se borra del array del item para no perder data).

import { db } from "@/lib/db";

export type MenuTag = {
  slug: string;
  label: string;
  emoji?: string;
};

export const DEFAULT_MENU_TAGS: MenuTag[] = [
  { slug: "firma", label: "De la casa", emoji: "⭐" },
  { slug: "popular", label: "Favorito", emoji: "🔥" },
  { slug: "veg", label: "Vegetariano", emoji: "🌱" },
  { slug: "spicy", label: "Picante", emoji: "🌶️" },
  { slug: "nuevo", label: "Nuevo", emoji: "✨" },
];

// Bounds for the operator-editable list.
export const MAX_MENU_TAGS = 20;
export const MAX_TAGS_PER_ITEM = 8;
export const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/**
 * Resolve the JSON blob stored in Restaurant.menuTags into a clean
 * array. Anything malformed falls back to defaults so the operator
 * never sees an empty / broken tags surface.
 */
export function resolveMenuTags(stored: unknown): MenuTag[] {
  if (stored === null || stored === undefined) return DEFAULT_MENU_TAGS;
  if (!Array.isArray(stored)) return DEFAULT_MENU_TAGS;
  const out: MenuTag[] = [];
  const seen = new Set<string>();
  for (const raw of stored) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const slug = typeof r.slug === "string" ? r.slug.trim() : "";
    const label = typeof r.label === "string" ? r.label.trim() : "";
    if (!slug || !label || !SLUG_REGEX.test(slug) || seen.has(slug)) continue;
    seen.add(slug);
    const emoji =
      typeof r.emoji === "string" && r.emoji.trim() ? r.emoji.trim() : undefined;
    out.push(emoji ? { slug, label, emoji } : { slug, label });
  }
  // Operator can intentionally save an empty list to disable tags
  // entirely (no chips on diner menu) — that's valid; don't override
  // it with defaults. But malformed JSON (e.g. "[]" wasn't passed but
  // stored was an object) already fell through to DEFAULT above.
  if (out.length === 0 && Array.isArray(stored) && stored.length > 0) {
    return DEFAULT_MENU_TAGS;
  }
  return out;
}

/** Convenience: read the resolved tag list for a restaurant in one call. */
export async function getRestaurantMenuTags(
  restaurantId: string,
): Promise<MenuTag[]> {
  const r = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { menuTags: true },
  });
  if (!r) return DEFAULT_MENU_TAGS;
  return resolveMenuTags(r.menuTags);
}
