/**
 * Render del documento legal en servidor, con next-intl y el selector de
 * idioma simulados: el cuerpo se pinta con el renderizador de la ayuda,
 * el índice apunta a las anclas de las secciones, el contacto es un mailto
 * y cada documento enlaza al otro.
 */
import { describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { locales } from "@/i18n/config";

vi.mock("next-intl/server", () => {
  const t = (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key;
  t.rich = (key: string, tags: Record<string, (chunks: ReactNode) => ReactNode>) =>
    createElement("span", { "data-key": key }, ...Object.values(tags).map((fn) => fn(key)));
  return { getTranslations: async () => t };
});
vi.mock("@/components/LocaleSwitcher", () => ({
  LocaleSwitcher: () => createElement("div", { "data-locale-switcher": "" }),
}));

import { LegalDocumentView } from "./LegalDocumentView";
import { LEGAL_CONTACT_EMAIL, LEGAL_DOCUMENTS, LEGAL_PATHS } from "@/content/legal";
import { helpHeadings, parseHelpMarkdown } from "@/lib/help/markdown";

describe("LegalDocumentView", () => {
  it.each(locales)("pinta la política de privacidad en %s con su índice y contacto", async (locale) => {
    const html = renderToStaticMarkup(await LegalDocumentView({ id: "privacidad", locale }));
    expect(html).toContain("privacyTitle");
    expect(html).toContain("updatedOn:");
    expect(html).toContain(`href="mailto:${LEGAL_CONTACT_EMAIL}"`);
    expect(html).toContain(`href="${LEGAL_PATHS.terminos}"`);
    expect(html).toContain("data-locale-switcher");
    // Cada sección del texto tiene su ancla y aparece en el índice.
    const headings = helpHeadings(parseHelpMarkdown(LEGAL_DOCUMENTS.privacidad[locale]));
    for (const h of headings.filter((x) => x.level === 2)) {
      expect(html).toContain(`id="${h.id}"`);
      expect(html).toContain(`href="#${h.id}"`);
    }
    // Sin HTML crudo: el texto llega escapado por React.
    expect(html).not.toContain("<script");
  });

  it("los términos enlazan a la política de privacidad", async () => {
    const html = renderToStaticMarkup(await LegalDocumentView({ id: "terminos", locale: "es" }));
    expect(html).toContain("termsTitle");
    expect(html).toContain(`href="${LEGAL_PATHS.privacidad}"`);
  });
});
