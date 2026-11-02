/**
 * Guardarraíles de los documentos legales (política de privacidad y términos
 * de servicio). Corren en cada CI:
 *
 *  - Los seis textos (dos documentos × tres idiomas) respetan el markdown
 *    reducido del centro de ayuda, con el que se pintan.
 *  - Identifican al responsable como MESAPAY y dan el único canal de
 *    contacto (info@mesapay.co); no queda ningún placeholder entre corchetes.
 *  - Las tres versiones de cada documento tienen las mismas secciones.
 *  - El español es neutro (sin voseo) y los enlaces internos existen.
 *  - La fecha de actualización es ISO y no es futura.
 */
import { describe, expect, it } from "vitest";
import { existsSync } from "fs";
import { join } from "path";
import { locales } from "@/i18n/config";
import {
  helpHeadings,
  helpLinks,
  parseHelpMarkdown,
  validateHelpMarkdown,
} from "@/lib/help/markdown";
import { findVoseo } from "@/lib/help/voseo";
import { LEGAL_CONTACT_EMAIL, LEGAL_DOCUMENTS, LEGAL_PATHS, legalBody } from "./index";

const HERE = import.meta.dirname ?? __dirname;
const APP_DIR = join(HERE, "../../app");

const docs = Object.entries(LEGAL_DOCUMENTS) as Array<
  [keyof typeof LEGAL_DOCUMENTS, (typeof LEGAL_DOCUMENTS)[keyof typeof LEGAL_DOCUMENTS]]
>;

/** Texto sin los enlaces `[texto](/ruta)`, para buscar corchetes sueltos. */
const withoutLinks = (text: string) => text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

// Orientativo: 1.200–1.800 palabras por documento; el tope deja margen porque
// la política cubre tres tipos de titulares y los términos, muchos módulos.
const WORD_MIN = 1100;
const WORD_MAX = 2600;

describe("documentos legales", () => {
  it("hay dos documentos con texto en los tres idiomas", () => {
    expect(docs.map(([id]) => id).sort()).toEqual(["privacidad", "terminos"]);
    for (const [id, doc] of docs) {
      for (const locale of locales) {
        expect(legalBody(doc, locale).trim().length, `${id}/${locale}`).toBeGreaterThan(0);
      }
    }
  });

  it("cada texto respeta el markdown reducido", () => {
    for (const [id, doc] of docs) {
      for (const locale of locales) {
        expect(validateHelpMarkdown(legalBody(doc, locale)), `${id}/${locale}`).toEqual([]);
      }
    }
  });

  it("identifican a MESAPAY y el correo de contacto, sin placeholders", () => {
    for (const [id, doc] of docs) {
      for (const locale of locales) {
        const text = legalBody(doc, locale);
        const where = `${id}/${locale}`;
        expect(text, where).toContain("MESAPAY");
        expect(text, where).toContain(LEGAL_CONTACT_EMAIL);
        // Nada de "[RAZÓN SOCIAL]", "[NIT]" ni similares: fuera de los
        // enlaces internos no puede quedar ningún corchete.
        expect(withoutLinks(text), `${where}: placeholder entre corchetes`).not.toMatch(/[[\]]/);
      }
    }
  });

  it("las tres versiones de cada documento tienen las mismas secciones", () => {
    for (const [id, doc] of docs) {
      const es = helpHeadings(parseHelpMarkdown(doc.es));
      expect(es.filter((h) => h.level === 2).length, `${id}/es`).toBeGreaterThanOrEqual(10);
      for (const locale of locales) {
        const hs = helpHeadings(parseHelpMarkdown(legalBody(doc, locale)));
        expect(hs.map((h) => h.level), `${id}/${locale}: estructura de secciones`).toEqual(
          es.map((h) => h.level),
        );
      }
    }
  });

  it("tienen una extensión razonable en cada idioma", () => {
    for (const [id, doc] of docs) {
      for (const locale of locales) {
        const words = legalBody(doc, locale).split(/\s+/).filter(Boolean).length;
        expect(words, `${id}/${locale}: ${words} palabras`).toBeGreaterThanOrEqual(WORD_MIN);
        expect(words, `${id}/${locale}: ${words} palabras`).toBeLessThanOrEqual(WORD_MAX);
      }
    }
  });

  it("el español es neutro: sin voseo", () => {
    for (const [id, doc] of docs) {
      expect(findVoseo(doc.es), `${id}/es`).toBeNull();
    }
  });

  it("los enlaces internos llevan a páginas que existen", () => {
    for (const [id, doc] of docs) {
      for (const locale of locales) {
        for (const href of helpLinks(parseHelpMarkdown(legalBody(doc, locale)))) {
          const path = href.split("#")[0].split("?")[0];
          expect(
            existsSync(join(APP_DIR, path, "page.tsx")),
            `${id}/${locale} → ${href}`,
          ).toBe(true);
        }
      }
    }
  });

  it("cada documento se cruza con el otro", () => {
    expect(helpLinks(parseHelpMarkdown(LEGAL_DOCUMENTS.privacidad.es))).toContain(LEGAL_PATHS.terminos);
    expect(helpLinks(parseHelpMarkdown(LEGAL_DOCUMENTS.terminos.es))).toContain(LEGAL_PATHS.privacidad);
  });

  it("la fecha de actualización es ISO y no es futura", () => {
    const today = new Date().toISOString().slice(0, 10);
    for (const [id, doc] of docs) {
      expect(doc.updatedAt, id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(doc.updatedAt)), id).toBe(false);
      expect(doc.updatedAt <= today, `${id}: fecha futura`).toBe(true);
    }
  });

  it("las rutas públicas de los documentos existen", () => {
    for (const path of Object.values(LEGAL_PATHS)) {
      expect(existsSync(join(APP_DIR, path, "page.tsx")), path).toBe(true);
    }
  });
});
