/**
 * Guardarraíles permanentes del centro de ayuda. Corren en cada CI:
 *
 *  - Toda pantalla de los comercios, su equipo y sus comensales está en el
 *    mapa de cobertura: una pantalla nueva sin ayuda rompe la CI.
 *  - Todo slug del mapa existe en el outline.
 *  - Los tres idiomas tienen las mismas categorías y los mismos artículos.
 *  - Una categoría con artículos tiene exactamente los del outline.
 *  - Todo enlace (los "Ir a…" y los del texto) lleva a una ruta que existe.
 *  - El formato de cada artículo es válido (campos, markdown, español sin voseo).
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, statSync } from "fs";
import { join, relative, sep } from "path";
import { locales, type Locale } from "@/i18n/config";
import { HELP_CATEGORIES, HELP_CATEGORY_IDS } from "./categories";
import { HELP_COVERAGE } from "./coverage";
import { HELP_OUTLINE, outlineSlugs } from "./outline";
import { HELP_CONTENT } from "./registry";
import { HELP_AUDIENCES, type HelpArticle } from "./types";
import {
  helpLinks,
  parseHelpMarkdown,
  validateHelpMarkdown,
} from "@/lib/help/markdown";

const HERE = import.meta.dirname ?? __dirname;
const APP_DIR = join(HERE, "../../app");

/** Carpetas cuyas pantallas tienen que estar en el mapa de cobertura. */
const COVERED_ROOTS = ["operator", "mesero", "t/[slug]", "r", "p", "terminal"];

/* ───────────────────────────── Rutas de src/app ───────────────────────────── */

function pageFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      // Carpetas privadas (_x) y slots paralelos (@x) no son rutas.
      if (name.startsWith("_") || name.startsWith("@")) continue;
      out.push(...pageFiles(full));
    } else if (/^page\.(tsx|ts|jsx|js)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

/** "src/app/operator/(x)/orders/[id]/page.tsx" → "/operator/orders/[id]". */
function routeOf(file: string): string {
  const segments = relative(APP_DIR, file)
    .split(sep)
    .slice(0, -1)
    .filter((s) => !(s.startsWith("(") && s.endsWith(")")));
  return "/" + segments.join("/");
}

const ALL_ROUTES = pageFiles(APP_DIR).map(routeOf);

function routeMatches(pattern: string, path: string): boolean {
  const ps = pattern.split("/").filter(Boolean);
  const xs = path.split("/").filter(Boolean);
  let i = 0;
  for (; i < ps.length; i++) {
    const p = ps[i];
    if (p.startsWith("[[...")) return true; // cero o más segmentos
    if (p.startsWith("[...")) return xs.length > i; // uno o más
    if (i >= xs.length) return false;
    if (p.startsWith("[") && p.endsWith("]")) continue; // un segmento cualquiera
    if (decodeURIComponent(xs[i]) !== p) return false;
  }
  return i === xs.length;
}

/** Ruta del enlace sin ancla ni consulta. */
const pathOf = (href: string) => href.split("#")[0].split("?")[0] || "/";

function routeExists(href: string): boolean {
  const path = pathOf(href);
  if (path.includes("[")) return false; // un enlace no puede traer "[id]" literal
  return ALL_ROUTES.some((r) => routeMatches(r, path));
}

/* ───────────────────────────── Datos ───────────────────────────── */

const articlesOf = (locale: Locale, cat: (typeof HELP_CATEGORY_IDS)[number]) =>
  HELP_CONTENT[locale][cat].articles;

const allArticles = (locale: Locale) =>
  HELP_CATEGORY_IDS.flatMap((cat) =>
    articlesOf(locale, cat).map((a) => ({ cat, a })),
  );

/* ───────────────────────────── Cobertura ───────────────────────────── */

describe("mapa de cobertura", () => {
  const covered = ALL_ROUTES.filter((r) =>
    COVERED_ROOTS.some((root) => r === `/${root}` || r.startsWith(`/${root}/`)),
  );

  it("encuentra las pantallas (sanidad del recorrido)", () => {
    expect(covered.length).toBeGreaterThan(100);
    expect(covered).toContain("/operator/orders/[id]");
    expect(covered).toContain("/t/[slug]/menu");
  });

  it("toda pantalla de esas carpetas está en el mapa", () => {
    const missing = covered.filter((r) => !(r in HELP_COVERAGE));
    expect(
      missing,
      "Pantallas sin ayuda: agrégalas a src/content/help/coverage.ts con los slugs del outline que las explican, o márcalas { internal: \"motivo\" }.",
    ).toEqual([]);
  });

  it("el mapa no tiene pantallas que ya no existen", () => {
    const stale = Object.keys(HELP_COVERAGE).filter((r) => !covered.includes(r));
    expect(stale).toEqual([]);
  });

  it("todo slug del mapa existe en el outline, y toda pantalla interna dice por qué", () => {
    const known = new Set(outlineSlugs());
    for (const [route, entry] of Object.entries(HELP_COVERAGE)) {
      if ("internal" in entry) {
        expect(entry.internal.trim().length, route).toBeGreaterThan(0);
      } else {
        expect(entry.length, route).toBeGreaterThan(0);
        for (const slug of entry) expect(known.has(slug), `${route} → ${slug}`).toBe(true);
      }
    }
  });
});

/* ───────────────────────────── Outline ───────────────────────────── */

describe("outline", () => {
  it("tiene un bloque por categoría, sin vacíos", () => {
    expect(Object.keys(HELP_OUTLINE).sort()).toEqual([...HELP_CATEGORY_IDS].sort());
    for (const cat of HELP_CATEGORY_IDS) expect(HELP_OUTLINE[cat].length, cat).toBeGreaterThan(0);
  });

  it("los slugs son únicos en toda la ayuda y en kebab-case", () => {
    const slugs = outlineSlugs();
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of slugs) expect(s).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("cada entrada tiene título y qué cubrir", () => {
    for (const list of Object.values(HELP_OUTLINE)) {
      for (const e of list) {
        expect(e.title.trim(), e.slug).not.toBe("");
        expect(e.covers.trim(), e.slug).not.toBe("");
      }
    }
  });
});

/* ───────────────────────────── Contenido ───────────────────────────── */

describe("contenido trilingüe", () => {
  it("cada idioma tiene un archivo por categoría, y nada más", () => {
    for (const locale of locales) {
      const files = readdirSync(join(HERE, locale))
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(/\.json$/, ""))
        .sort();
      expect(files, locale).toEqual([...HELP_CATEGORY_IDS].sort());
      expect(Object.keys(HELP_CONTENT[locale]).sort(), locale).toEqual(
        [...HELP_CATEGORY_IDS].sort(),
      );
    }
  });

  it("los tres idiomas tienen exactamente los mismos slugs, en el mismo orden", () => {
    for (const cat of HELP_CATEGORY_IDS) {
      const es = articlesOf("es", cat).map((a) => a.slug);
      for (const locale of locales) {
        expect(articlesOf(locale, cat).map((a) => a.slug), `${locale}/${cat}`).toEqual(es);
      }
    }
  });

  it("una categoría con artículos tiene todos los del outline y ninguno más, en su orden", () => {
    for (const locale of locales) {
      for (const cat of HELP_CATEGORY_IDS) {
        const slugs = articlesOf(locale, cat).map((a) => a.slug);
        if (slugs.length === 0) continue; // pendiente: no se muestra
        expect(slugs, `${locale}/${cat}`).toEqual(HELP_OUTLINE[cat].map((e) => e.slug));
      }
    }
  });

  it("cada categoría tiene título y descripción en los tres idiomas", () => {
    for (const locale of locales) {
      for (const cat of HELP_CATEGORIES) {
        const c = HELP_CONTENT[locale][cat.id];
        expect(c.title.trim(), `${locale}/${cat.id}`).not.toBe("");
        expect(c.description.trim(), `${locale}/${cat.id}`).not.toBe("");
      }
    }
  });

  it("cada artículo tiene todos sus campos bien formados", () => {
    const today = new Date().toISOString().slice(0, 10);
    for (const locale of locales) {
      for (const { cat, a } of allArticles(locale)) {
        const where = `${locale}/${cat}/${a.slug}`;
        const keys: (keyof HelpArticle)[] = [
          "slug", "title", "summary", "keywords", "audience", "body", "links", "updated",
        ];
        expect(Object.keys(a).sort(), where).toEqual([...keys].sort());
        expect(a.title.trim(), where).not.toBe("");
        expect(a.summary.trim(), where).not.toBe("");
        expect(a.summary.length, `${where}: resumen de una o dos frases`).toBeLessThanOrEqual(260);
        expect(a.keywords.length, `${where}: palabras clave`).toBeGreaterThanOrEqual(3);
        for (const k of a.keywords) expect(k.trim(), where).not.toBe("");
        expect(a.audience.length, where).toBeGreaterThan(0);
        for (const au of a.audience) expect(HELP_AUDIENCES, where).toContain(au);
        expect(a.updated, where).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(Number.isNaN(Date.parse(a.updated)), where).toBe(false);
        expect(a.updated <= today, `${where}: fecha futura`).toBe(true);
        for (const l of a.links) expect(l.label.trim(), where).not.toBe("");
      }
    }
  });

  it("el cuerpo respeta el markdown reducido", () => {
    for (const locale of locales) {
      for (const { cat, a } of allArticles(locale)) {
        expect(validateHelpMarkdown(a.body), `${locale}/${cat}/${a.slug}`).toEqual([]);
      }
    }
  });

  it("el español es neutro: sin voseo (salvo en los textos de la interfaz, en negrita)", () => {
    // Formas de vos que no existen con tú/usted. Se revisa el texto fuera de
    // **negritas** y `código`, que es donde van las etiquetas exactas de la
    // interfaz (algunas todavía están con vos).
    const VOSEO =
      /\b(tocá|tocás|elegí|escribí|abrí|entrá|andá|mirá|revisá|pegá|copiá|guardá|poné|hacé|tené|podés|tenés|querés|sabés|necesitás|usá|probá|fijate|apretá|activá|cerrá|cargá|subí|creá|dejá|pedile|decile|escribinos|mandanos|avisanos|vos)\b/i;
    for (const { cat, a } of allArticles("es")) {
      const text = [a.title, a.summary, ...a.links.map((l) => l.label), a.body]
        .join("\n")
        .replace(/```[\s\S]*?```/g, "")
        .replace(/\*\*[^*]+\*\*/g, "")
        .replace(/`[^`]*`/g, "");
      const m = VOSEO.exec(text);
      expect(m?.[0] ?? null, `es/${cat}/${a.slug}`).toBeNull();
    }
  });
});

/* ───────────────────────────── Enlaces ───────────────────────────── */

describe("enlaces", () => {
  it("todo enlace lleva a una ruta que existe en src/app", () => {
    const broken: string[] = [];
    for (const locale of locales) {
      for (const { cat, a } of allArticles(locale)) {
        const hrefs = [...a.links.map((l) => l.href), ...helpLinks(parseHelpMarkdown(a.body))];
        for (const href of hrefs) {
          if (!routeExists(href)) broken.push(`${locale}/${cat}/${a.slug} → ${href}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it("los enlaces a otros artículos de ayuda apuntan a artículos publicados", () => {
    const broken: string[] = [];
    for (const locale of locales) {
      const published = new Set(allArticles(locale).map(({ cat, a }) => `${cat}/${a.slug}`));
      for (const { cat, a } of allArticles(locale)) {
        const hrefs = [...a.links.map((l) => l.href), ...helpLinks(parseHelpMarkdown(a.body))];
        for (const href of hrefs) {
          const m = /^\/(?:operator|mesero)\/ayuda\/([^/]+)\/([^/]+)$/.exec(pathOf(href));
          if (m && !published.has(`${m[1]}/${m[2]}`)) {
            broken.push(`${locale}/${cat}/${a.slug} → ${href}`);
          }
        }
      }
    }
    expect(
      broken,
      "Solo se puede enlazar a artículos que ya tienen contenido en ese idioma.",
    ).toEqual([]);
  });

  it("el resolutor de rutas entiende los segmentos dinámicos", () => {
    expect(routeExists("/operator/settings/impresoras")).toBe(true);
    expect(routeExists("/operator/contabilidad?tab=chart")).toBe(true);
    expect(routeExists("/operator/ayuda#impresoras")).toBe(true);
    expect(routeExists("/operator/ayuda/primeros-pasos/por-donde-empezar")).toBe(true);
    expect(routeExists("/t/mi-restaurante/menu")).toBe(true);
    expect(routeExists("/operator/no-existe")).toBe(false);
    expect(routeExists("/operator/orders/[id]")).toBe(false);
    expect(existsSync(APP_DIR)).toBe(true);
  });
});
