/**
 * Tipos de los documentos legales (política de privacidad y términos de
 * servicio).
 *
 * Cada documento es un módulo de `src/content/legal/` con el texto en los
 * tres idiomas, escrito en el mismo markdown reducido del centro de ayuda
 * (`src/lib/help/markdown.ts`) y pintado con el mismo renderizador. El
 * español es la fuente; inglés y portugués son traducciones fieles.
 *
 * Viven en código (y no en `messages/*.json`) porque los catálogos de
 * next-intl se mandan enteros a todas las páginas y estos textos sólo los
 * necesitan /privacidad y /terminos.
 */
import type { Locale } from "@/i18n/config";

export type LegalDocument = {
  /** Fecha ISO (AAAA-MM-DD) de la última versión publicada. */
  updatedAt: string;
  es: string;
  en: string;
  pt: string;
};

export type LegalDocumentId = "privacidad" | "terminos";

/** Texto del documento en un idioma. */
export function legalBody(doc: LegalDocument, locale: Locale): string {
  return doc[locale];
}
