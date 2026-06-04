import "server-only";
import { db } from "@/lib/db";
import { resolveMenuTags } from "@/lib/menuTags";
import {
  getContentTranslations,
  type TranslatableItem,
} from "@/lib/translateContent";
import { locales, defaultLocale, type Locale } from "@/i18n/config";

/**
 * Pre-traducción de la CARTA completa de un comercio (categorías, menús,
 * platos, etiquetas) a todos los idiomas no-default. Reusa
 * getContentTranslations: es cache-first (no re-traduce lo que no cambió) y
 * respeta overrides manuales (source="manual" con sourceHash vigente).
 */

/** Junta todo el texto traducible de la carta como TranslatableItem[]. */
export async function collectMenuTranslatables(
  restaurantId: string,
): Promise<TranslatableItem[]> {
  const [cats, menus, items, tenant] = await Promise.all([
    db.category.findMany({
      where: { restaurantId },
      select: { id: true, label: true },
    }),
    db.menu.findMany({
      where: { restaurantId },
      select: { id: true, label: true, description: true },
    }),
    db.menuItem.findMany({
      where: { restaurantId },
      select: { id: true, name: true, description: true },
    }),
    db.restaurant.findUnique({
      where: { id: restaurantId },
      select: { menuTags: true },
    }),
  ]);

  const out: TranslatableItem[] = [];
  const push = (
    entityType: string,
    entityId: string,
    field: string,
    text: string | null | undefined,
  ) => {
    if (text && text.trim()) out.push({ entityType, entityId, field, text });
  };

  for (const c of cats) push("Category", c.id, "label", c.label);
  for (const m of menus) {
    push("Menu", m.id, "label", m.label);
    push("Menu", m.id, "description", m.description);
  }
  for (const it of items) {
    push("MenuItem", it.id, "name", it.name);
    push("MenuItem", it.id, "description", it.description);
  }
  for (const tag of resolveMenuTags(tenant?.menuTags)) {
    push("MenuTag", tag.slug, "label", tag.label);
  }
  return out;
}

const CHUNK = 25; // ítems por llamada a la IA (cabe en max_tokens holgado)

export type PretranslateResult = {
  strings: number; // strings traducibles encontrados
  locales: string[]; // idiomas generados (en/pt)
};

/**
 * Genera (y cachea) las traducciones de toda la carta a en/pt. Síncrono:
 * el operador toca el botón una vez y espera. Devuelve un resumen.
 */
export async function pretranslateMenu(
  restaurantId: string,
): Promise<PretranslateResult> {
  const items = await collectMenuTranslatables(restaurantId);
  const targets = locales.filter((l) => l !== defaultLocale) as Locale[];
  for (const locale of targets) {
    for (let i = 0; i < items.length; i += CHUNK) {
      // generateMissing: true → ESTA ruta sí llama a la IA (en chunks) y
      // persiste. El render del menú queda solo-caché (instantáneo).
      await getContentTranslations(locale, items.slice(i, i + CHUNK), {
        generateMissing: true,
      });
    }
  }
  return { strings: items.length, locales: targets };
}
