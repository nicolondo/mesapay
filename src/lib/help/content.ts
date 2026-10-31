import "server-only";
import type { Locale } from "@/i18n/config";
import { HELP_CATEGORIES, isHelpCategoryId } from "@/content/help/categories";
import { HELP_CONTENT } from "@/content/help/registry";
import type {
  HelpArticle,
  HelpAudience,
  HelpCategory,
} from "@/content/help/types";
import {
  helpHeadings,
  helpPlainText,
  parseHelpMarkdown,
  type HelpBlock,
} from "./markdown";
import { normalizeForSearch, type HelpIndexEntry } from "./search";

/**
 * Lectura del contenido de la ayuda para el idioma activo. Sólo servidor:
 * el contenido completo nunca viaja al navegador; al cliente le llega el
 * índice del buscador (y sólo en la portada de la ayuda).
 */

const forAudience = (a: HelpArticle, audience?: HelpAudience) =>
  !audience || a.audience.includes(audience);

/** Todas las categorías en orden, incluidas las pendientes (sin artículos). */
export function helpCategories(locale: Locale): HelpCategory[] {
  return HELP_CATEGORIES.map((c) => ({
    ...HELP_CONTENT[locale][c.id],
    id: c.id,
    icon: c.icon,
  }));
}

/**
 * Categorías que se muestran: las que tienen artículos (para esa audiencia,
 * si se pide). Una categoría con `"articles": []` está pendiente y no sale.
 */
export function visibleHelpCategories(
  locale: Locale,
  audience?: HelpAudience,
): HelpCategory[] {
  return helpCategories(locale)
    .map((c) => ({ ...c, articles: c.articles.filter((a) => forAudience(a, audience)) }))
    .filter((c) => c.articles.length > 0);
}

/** Una categoría visible, o null si no existe o está pendiente. */
export function helpCategory(locale: Locale, id: string): HelpCategory | null {
  if (!isHelpCategoryId(id)) return null;
  return visibleHelpCategories(locale).find((c) => c.id === id) ?? null;
}

export type ResolvedHelpArticle = {
  category: HelpCategory;
  article: HelpArticle;
  blocks: HelpBlock[];
};

export function helpArticle(
  locale: Locale,
  categoryId: string,
  slug: string,
  audience?: HelpAudience,
): ResolvedHelpArticle | null {
  const category = helpCategory(locale, categoryId);
  const article = category?.articles.find((a) => a.slug === slug);
  if (!category || !article || !forAudience(article, audience)) return null;
  return { category, article, blocks: parseHelpMarkdown(article.body) };
}

/**
 * Hasta `limit` artículos de la misma categoría, primero los que comparten
 * más palabras clave con el actual y después en el orden de la categoría.
 */
export function relatedHelpArticles(
  category: HelpCategory,
  article: HelpArticle,
  opts: { audience?: HelpAudience; limit?: number } = {},
): HelpArticle[] {
  const mine = new Set(article.keywords.map(normalizeForSearch));
  return category.articles
    .map((a, order) => ({
      a,
      order,
      shared: a.keywords.filter((k) => mine.has(normalizeForSearch(k))).length,
    }))
    .filter(({ a }) => a.slug !== article.slug && forAudience(a, opts.audience))
    .sort((x, y) => y.shared - x.shared || x.order - y.order)
    .slice(0, opts.limit ?? 4)
    .map(({ a }) => a);
}

/** Índice del buscador para un idioma (y una audiencia, si se pide). */
export function buildHelpSearchIndex(
  locale: Locale,
  audience?: HelpAudience,
): HelpIndexEntry[] {
  return visibleHelpCategories(locale, audience).flatMap((c) =>
    c.articles.map((a) => {
      const blocks = parseHelpMarkdown(a.body);
      return {
        c: c.id,
        s: a.slug,
        t: a.title,
        m: a.summary,
        k: a.keywords.join(" · "),
        h: helpHeadings(blocks)
          .map((h) => h.text)
          .join(" · "),
        b: helpPlainText(blocks),
      };
    }),
  );
}

/** ¿Hay artículos para esa audiencia? (para mostrar o no el acceso). */
export function hasHelpFor(locale: Locale, audience: HelpAudience): boolean {
  return visibleHelpCategories(locale, audience).length > 0;
}
