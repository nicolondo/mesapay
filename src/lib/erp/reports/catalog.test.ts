import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPORT_CATALOG } from "./catalog";
import { parseContabilidadTab } from "../contabilidadTabs";

const ROOT = path.resolve(__dirname, "../../../..");
const items = REPORT_CATALOG.flatMap((c) => c.items);

function splitHref(href: string): { pathname: string; tab: string | null } {
  const q = href.indexOf("?");
  if (q < 0) return { pathname: href, tab: null };
  return { pathname: href.slice(0, q), tab: new URLSearchParams(href.slice(q + 1)).get("tab") };
}

describe("REPORT_CATALOG — integridad", () => {
  it("cubre las cinco categorías, sin claves ni rutas repetidas", () => {
    expect(REPORT_CATALOG.map((c) => c.key)).toEqual([
      "contables",
      "financieros",
      "tributarios",
      "comerciales",
      "operativos",
    ]);
    const hrefs = items.map((i) => i.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(items.length).toBeGreaterThanOrEqual(14);
  });

  it("toda ruta existe como página en src/app y toda pestaña pedida es real", () => {
    for (const { href } of items) {
      const { pathname, tab } = splitHref(href);
      const page = path.join(ROOT, "src/app", pathname, "page.tsx");
      expect(fs.existsSync(page), `${href} → ${page}`).toBe(true);
      if (tab != null) expect(parseContabilidadTab(tab), href).not.toBeNull();
    }
  });

  it("todas las claves i18n existen en es, en y pt", () => {
    const catalogs = Object.fromEntries(
      (["es", "en", "pt"] as const).map((l) => [
        l,
        JSON.parse(fs.readFileSync(path.join(ROOT, "messages", `${l}.json`), "utf8")) as Record<
          string,
          Record<string, string>
        >,
      ]),
    );
    const refs = [
      ...REPORT_CATALOG.map((c) => [c.ns, c.labelKey] as const),
      ...items.flatMap((i) => [[i.ns, i.nameKey] as const, [i.ns, i.descKey] as const]),
    ];
    for (const [locale, messages] of Object.entries(catalogs)) {
      for (const [ns, key] of refs) {
        expect(typeof messages[ns]?.[key], `${locale}: ${ns}.${key}`).toBe("string");
      }
    }
  });
});
