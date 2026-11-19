import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  OPERATOR_SEARCH_DESTINATIONS,
  SEARCH_EXCLUDED_SCREENS,
  destinationsForNav,
  filterSearchLinks,
  normalizeSearchText,
  searchHrefPath,
  type SearchLink,
} from "./operatorSearch";
import { buildOperatorNav } from "./operatorNav";
import { parseContabilidadTab } from "./erp/contabilidadTabs";
import { MODULE_SLUGS } from "./modules";
import { TAB_PARAM } from "@/app/operator/inventario/types";
import { HELP_COVERAGE } from "@/content/help/coverage";

const ROOT = path.resolve(__dirname, "../..");

/** "ns.clave" → string del catálogo, o undefined. */
function resolveKey(messages: Record<string, unknown>, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (acc, part) =>
        acc && typeof acc === "object" ? (acc as Record<string, unknown>)[part] : undefined,
      messages,
    );
}

function loadCatalog(locale: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(ROOT, "messages", `${locale}.json`), "utf8"),
  ) as Record<string, unknown>;
}

const es = loadCatalog("es");

/** Menú con TODO encendido (todos los módulos, bar, reservas). */
const FULL_NAV = buildOperatorNav({
  enabledModules: MODULE_SLUGS,
  hasBar: true,
  counterMode: false,
  reservationsEnabled: true,
});
const FULL_NAV_HREFS = FULL_NAV.flatMap((e) =>
  "children" in e ? e.children.map((c) => c.href) : [e.href],
);

describe("OPERATOR_SEARCH_DESTINATIONS — integridad del registro", () => {
  it("hrefs únicos y que no dupliquen ítems del menú", () => {
    const hrefs = OPERATOR_SEARCH_DESTINATIONS.map((d) => d.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const href of hrefs) {
      expect(FULL_NAV_HREFS, `${href} ya es ítem del menú`).not.toContain(href);
    }
  });

  it("todo href vive: la página existe y la pestaña pedida es real", () => {
    for (const dest of OPERATOR_SEARCH_DESTINATIONS) {
      const pathname = searchHrefPath(dest.href);
      const page = path.join(ROOT, "src/app", pathname, "page.tsx");
      expect(fs.existsSync(page), `${dest.href} → falta ${page}`).toBe(true);

      const q = dest.href.indexOf("?");
      const tab = q < 0 ? null : new URLSearchParams(dest.href.slice(q + 1)).get("tab");
      if (tab != null) {
        if (pathname === "/operator/contabilidad") {
          expect(parseContabilidadTab(tab), dest.href).not.toBeNull();
        } else if (pathname === "/operator/inventario") {
          expect(Object.values(TAB_PARAM), dest.href).toContain(tab);
        } else if (pathname === "/operator/compras") {
          // Pestañas de la lista de compras (ComprasTabs + filtros de la lista).
          expect(["unpaid"], dest.href).toContain(tab);
        } else {
          throw new Error(`Pestaña sin validador para ${dest.href} — agrega uno acá.`);
        }
      }
    }
  });

  it("todo parentHref es un ítem del menú con todo encendido", () => {
    const navPaths = new Set(FULL_NAV_HREFS.map(searchHrefPath));
    for (const dest of OPERATOR_SEARCH_DESTINATIONS) {
      expect(navPaths, `${dest.href}: padre ${dest.parentHref} no está en el menú`).toContain(
        dest.parentHref,
      );
    }
  });

  it("toda ruta del registro está mapeada en la ayuda (coverage.ts)", () => {
    for (const dest of OPERATOR_SEARCH_DESTINATIONS) {
      const pathname = searchHrefPath(dest.href);
      expect(HELP_COVERAGE[pathname], `${pathname} no está en HELP_COVERAGE`).toBeDefined();
    }
  });

  it("las claves i18n (rótulo, grupo y sinónimos) existen en es, en y pt", () => {
    for (const locale of ["es", "en", "pt"] as const) {
      const messages = loadCatalog(locale);
      for (const dest of OPERATOR_SEARCH_DESTINATIONS) {
        const keys = [dest.labelKey, dest.groupKey, dest.keywordsKey].filter(
          (k): k is string => k != null,
        );
        for (const key of keys) {
          expect(typeof resolveKey(messages, key), `${locale}: ${key} (${dest.href})`).toBe(
            "string",
          );
        }
      }
    }
  });

  it("cada pantalla estática del operador en la ayuda está en menú, registro o exclusiones", () => {
    const navPaths = new Set(FULL_NAV_HREFS.map(searchHrefPath));
    const registryPaths = new Set(
      OPERATOR_SEARCH_DESTINATIONS.map((d) => searchHrefPath(d.href)),
    );
    const missing = Object.keys(HELP_COVERAGE).filter(
      (screen) =>
        screen.startsWith("/operator/") &&
        !screen.includes("[") &&
        !navPaths.has(screen) &&
        !registryPaths.has(screen) &&
        !(screen in SEARCH_EXCLUDED_SCREENS),
    );
    expect(
      missing,
      "Pantalla nueva sin destino en ⌘K: regístrala en OPERATOR_SEARCH_DESTINATIONS o exclúyela con razón en SEARCH_EXCLUDED_SCREENS (src/lib/operatorSearch.ts)",
    ).toEqual([]);
  });

  it("toda exclusión apunta a una pantalla real de la ayuda", () => {
    for (const [screen, reason] of Object.entries(SEARCH_EXCLUDED_SCREENS)) {
      expect(HELP_COVERAGE[screen], screen).toBeDefined();
      expect(reason.length, screen).toBeGreaterThan(10);
    }
  });
});

/* ── Comportamiento del buscador con los textos reales (es) ── */

const trEs = (key: string): string => {
  const v = resolveKey(es, key);
  if (typeof v !== "string") throw new Error(`clave es faltante: ${key}`);
  return v;
};

function buildLinksEs(): SearchLink[] {
  const operator = es.operator as Record<string, string>;
  const navLinks: SearchLink[] = FULL_NAV.flatMap((e) =>
    "children" in e
      ? e.children.map((c) => ({
          href: c.href,
          label: operator[c.labelKey],
          group: operator[e.labelKey],
        }))
      : [{ href: e.href, label: operator[e.labelKey], group: trEs("workspaceUi.workspace") }],
  );
  const subLinks: SearchLink[] = destinationsForNav(navLinks.map((l) => l.href)).map((d) => ({
    href: d.href,
    label: trEs(d.labelKey),
    group: trEs(d.groupKey),
    keywords: d.keywordsKey ? trEs(d.keywordsKey) : undefined,
    sub: true,
  }));
  return [...navLinks, ...subLinks];
}

describe("filterSearchLinks — con el menú y catálogo reales", () => {
  const links = buildLinksEs();

  it("«pagos» encuentra Pagos — Compras de primero (rótulo antes que sinónimos)", () => {
    const res = filterSearchLinks(links, "pagos");
    expect(res[0]).toMatchObject({ href: "/operator/compras/pagos", group: "Compras" });
    expect(res[0].label).toBe("Pagos");
    // La tarjeta Pagos de Configuración también sale, después (orden del registro).
    expect(res.map((r) => r.href)).toContain("/operator/settings/pagos");
  });

  it("«proveedores» encuentra Pagos — Compras por sinónimo, tras las coincidencias de rótulo", () => {
    const res = filterSearchLinks(links, "proveedores");
    const hrefs = res.map((r) => r.href);
    expect(hrefs).toContain("/operator/compras/pagos");
    // El ítem del menú con «proveedores» en el rótulo va antes que el sinónimo.
    expect(hrefs.indexOf("/operator/reportes/proveedores")).toBeLessThan(
      hrefs.indexOf("/operator/compras/pagos"),
    );
  });

  it("«por pagar» encuentra la pestaña de Compras", () => {
    const res = filterSearchLinks(links, "por pagar");
    expect(res[0]).toMatchObject({
      href: "/operator/compras?tab=unpaid",
      label: "Por pagar",
      group: "Compras",
    });
  });

  it("ignora acentos y mayúsculas en consulta, rótulos y sinónimos", () => {
    expect(filterSearchLinks(links, "PÁGOS")[0]?.href).toBe("/operator/compras/pagos");
    expect(
      filterSearchLinks(links, "conciliacion").some(
        (r) => r.href === "/operator/contabilidad?tab=bancos",
      ),
    ).toBe(true);
    expect(normalizeSearchText("Conciliación BANCARIA")).toBe("conciliacion bancaria");
  });

  it("a igualdad de coincidencia, las secciones del menú van antes que las subsecciones", () => {
    const res = filterSearchLinks(links, "compras");
    expect(res[0]).toMatchObject({ href: "/operator/compras", label: "Compras" });
    const subIdx = res.findIndex((r) => r.sub);
    expect(subIdx).toBeGreaterThan(0);
  });

  it("consulta vacía: todo el menú primero y luego las subsecciones", () => {
    const res = filterSearchLinks(links, "");
    expect(res.length).toBe(links.length);
    const firstSub = res.findIndex((r) => r.sub);
    expect(res.slice(0, firstSub).every((r) => !r.sub)).toBe(true);
  });
});

describe("destinationsForNav — gating por menú", () => {
  it("sin el ítem padre (módulo apagado) sus subsecciones no aparecen", () => {
    const noPurchasing = FULL_NAV_HREFS.filter(
      (h) => searchHrefPath(h) !== "/operator/compras",
    );
    const hrefs = destinationsForNav(noPurchasing).map((d) => d.href);
    expect(hrefs).not.toContain("/operator/compras/pagos");
    expect(hrefs).toContain("/operator/inventario?tab=conteos");
  });

  it("con una nav ajena (admin de plataforma) no aporta nada", () => {
    expect(destinationsForNav(["/admin/restaurants", "/admin/groups"])).toEqual([]);
  });

  it("no repite destinos que ya están en el menú como href exacto", () => {
    const withTab = [...FULL_NAV_HREFS, "/operator/compras?tab=unpaid"];
    const hrefs = destinationsForNav(withTab).map((d) => d.href);
    expect(hrefs).not.toContain("/operator/compras?tab=unpaid");
  });
});
