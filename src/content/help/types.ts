/**
 * Tipos del contenido del centro de ayuda.
 *
 * El contenido vive en `src/content/help/{es,en,pt}/<categoria>.json` (uno
 * por categoría y por idioma) y NO en `messages/*.json`: los catálogos de
 * next-intl se mandan enteros a todas las páginas, y los artículos sólo los
 * necesita la ayuda. Ver `src/content/help/README.md`.
 */
import type { HelpCategoryId } from "./categories";

/** Quién usa lo que describe el artículo. */
export const HELP_AUDIENCES = [
  "operator",
  "mesero",
  "cocina",
  "comensal",
  "admin",
] as const;
export type HelpAudience = (typeof HELP_AUDIENCES)[number];

/** Un acceso directo "Ir a…" al final del artículo. Sólo rutas internas. */
export type HelpLink = { label: string; href: string };

export type HelpArticle = {
  /** En español, kebab-case, igual en los tres idiomas y único en toda la ayuda. */
  slug: string;
  title: string;
  /** Una o dos frases: sale en las listas y en los resultados del buscador. */
  summary: string;
  /** Sinónimos y palabras que la gente escribe al buscar. */
  keywords: string[];
  audience: HelpAudience[];
  /** Markdown reducido: ver `src/lib/help/markdown.ts`. */
  body: string;
  links: HelpLink[];
  /** Fecha ISO (AAAA-MM-DD) de la última revisión contra el producto. */
  updated: string;
};

/** Forma de cada archivo `<idioma>/<categoria>.json`. */
export type HelpCategoryContent = {
  title: string;
  description: string;
  /** Vacío = categoría pendiente: no se muestra en el centro de ayuda. */
  articles: HelpArticle[];
};

/** Una categoría ya resuelta para un idioma, lista para pintar. */
export type HelpCategory = HelpCategoryContent & {
  id: HelpCategoryId;
  icon: string;
};
