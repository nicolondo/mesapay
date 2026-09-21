import { describe, expect, it } from "vitest";
import {
  buildOperatorNav,
  resolveActiveHref,
  type NavEntryDef,
  type NavGroupDef,
} from "./operatorNav";
import { parseContabilidadTab } from "./erp/contabilidadTabs";

const base = {
  enabledModules: [] as string[],
  hasBar: false,
  counterMode: false,
  reservationsEnabled: false,
};

function group(nav: NavEntryDef[], labelKey: string): NavGroupDef | undefined {
  return nav.find((e): e is NavGroupDef => "children" in e && e.labelKey === labelKey);
}

function hrefs(nav: NavEntryDef[]): string[] {
  return nav.flatMap((e) => ("children" in e ? e.children.map((c) => c.href) : [e.href]));
}

describe("buildOperatorNav — grupos Contabilidad y Reportes", () => {
  it("con `accounting` apagado no aparecen los grupos ni la entrada suelta", () => {
    const nav = buildOperatorNav({ ...base, enabledModules: ["inventory"] });
    expect(group(nav, "navAccounting")).toBeUndefined();
    expect(group(nav, "navGroupReports")).toBeUndefined();
    expect(hrefs(nav)).not.toContain("/operator/contabilidad");
    // Los demás grupos siguen ahí.
    expect(group(nav, "navErpGroup")?.children.map((c) => c.href)).toEqual([
      "/operator/inventario",
      "/operator/settings/insumos",
    ]);
    expect(group(nav, "navGroupBusiness")?.children[0]?.href).toBe("/operator/reports");
  });

  it("con `accounting` encendido aparecen los dos grupos con los ítems de zenith en orden", () => {
    const nav = buildOperatorNav({ ...base, enabledModules: ["accounting"] });
    const acc = group(nav, "navAccounting");
    const rep = group(nav, "navGroupReports");
    expect(acc?.children.map((c) => [c.labelKey, c.href])).toEqual([
      // Extra de MESAPAY: las pestañas que siguen viviendo en la página.
      ["navAccDaily", "/operator/contabilidad"],
      ["navAccChart", "/operator/contabilidad?tab=chart"],
      ["navAccVouchers", "/operator/contabilidad/comprobantes"],
      ["navAccLedger", "/operator/reportes/libro-mayor"],
      ["navAccDailyBook", "/operator/reportes/libro-diario"],
      ["navAccBudgets", "/operator/contabilidad?tab=presupuesto"],
      ["navAccFixedAssets", "/operator/contabilidad?tab=activos"],
      ["navAccDeferred", "/operator/contabilidad/diferidos"],
      ["navAccPeriodClose", "/operator/contabilidad/cierre"],
    ]);
    expect(rep?.children.map((c) => [c.labelKey, c.href])).toEqual([
      ["navRepAll", "/operator/reportes"],
      ["navRepCommissions", "/operator/reportes/comisiones"],
      ["navRepReceivables", "/operator/reportes/cartera"],
      ["navRepTaxes", "/operator/reportes/impuestos"],
      ["navRepBalanceSheet", "/operator/reportes/estado-situacion"],
      ["navRepIncome", "/operator/reportes/estado-resultado"],
      ["navRepTrialBalance", "/operator/reportes/balance-prueba"],
      ["navRepExogena", "/operator/reportes/exogena"],
    ]);
    // 8 + 8 de zenith, más "Gastos y diario".
    expect((acc?.children.length ?? 0) + (rep?.children.length ?? 0)).toBe(17);
  });

  it("los grupos van entre Administración y Negocio, sin entrada suelta de Contabilidad", () => {
    const nav = buildOperatorNav({ ...base, enabledModules: ["accounting", "staff"] });
    const order = nav.map((e) => e.labelKey);
    expect(order.indexOf("navErpGroup")).toBeLessThan(order.indexOf("navAccounting"));
    expect(order.indexOf("navAccounting") + 1).toBe(order.indexOf("navGroupReports"));
    expect(order.indexOf("navGroupReports")).toBeLessThan(order.indexOf("navGroupBusiness"));
    expect(group(nav, "navErpGroup")?.children.map((c) => c.href)).toEqual([
      "/operator/horarios",
      "/operator/nomina",
    ]);
  });

  it("no hay hrefs repetidos y toda pestaña pedida por `?tab=` existe", () => {
    const nav = buildOperatorNav({
      ...base,
      enabledModules: ["inventory", "purchasing", "recipes", "accounting", "production", "staff", "vouchers"],
      hasBar: true,
      reservationsEnabled: true,
    });
    const all = hrefs(nav);
    expect(new Set(all).size).toBe(all.length);
    for (const href of all) {
      const q = href.indexOf("?");
      if (q < 0) continue;
      const tab = new URLSearchParams(href.slice(q + 1)).get("tab");
      expect(parseContabilidadTab(tab), href).not.toBeNull();
    }
  });

  it("respeta bar, mostrador y reservas como antes", () => {
    const nav = buildOperatorNav({ ...base, hasBar: true, counterMode: true, reservationsEnabled: true });
    const keys = nav.map((e) => e.labelKey);
    expect(keys).toContain("navBar");
    expect(keys).toContain("navCounter");
    expect(keys).not.toContain("navTables");
    expect(keys).toContain("navReservations");
  });
});

describe("resolveActiveHref — un solo ítem activo", () => {
  const nav = buildOperatorNav({ ...base, enabledModules: ["accounting"] });

  it("la pestaña con ítem propio le gana a «Gastos y diario»", () => {
    expect(
      resolveActiveHref(nav, { pathname: "/operator/contabilidad", tab: "chart" }),
    ).toBe("/operator/contabilidad?tab=chart");
    expect(
      resolveActiveHref(nav, { pathname: "/operator/contabilidad", tab: "activos" }),
    ).toBe("/operator/contabilidad?tab=activos");
  });

  it("una pestaña sin ítem propio (o ninguna) enciende «Gastos y diario»", () => {
    expect(resolveActiveHref(nav, { pathname: "/operator/contabilidad", tab: "pnl" })).toBe(
      "/operator/contabilidad",
    );
    expect(resolveActiveHref(nav, { pathname: "/operator/contabilidad" })).toBe(
      "/operator/contabilidad",
    );
  });

  it("la subpágina más específica le gana al hub por prefijo", () => {
    expect(
      resolveActiveHref(nav, { pathname: "/operator/reportes/cartera/proveedor/x" }),
    ).toBe("/operator/reportes/cartera");
    expect(resolveActiveHref(nav, { pathname: "/operator/reportes" })).toBe("/operator/reportes");
    expect(
      resolveActiveHref(nav, { pathname: "/operator/contabilidad/comprobantes/abc/editar" }),
    ).toBe("/operator/contabilidad/comprobantes");
    expect(resolveActiveHref(nav, { pathname: "/operator/contabilidad/cierre" })).toBe(
      "/operator/contabilidad/cierre",
    );
  });

  it("Resumen sólo exacto; Menú vs Cartas y Cierre de turno vs Reportes no se pisan", () => {
    expect(resolveActiveHref(nav, { pathname: "/operator" })).toBe("/operator");
    expect(resolveActiveHref(nav, { pathname: "/operator/menus" })).toBe("/operator/menus");
    expect(resolveActiveHref(nav, { pathname: "/operator/menu/import" })).toBe("/operator/menu");
    expect(resolveActiveHref(nav, { pathname: "/operator/reports" })).toBe("/operator/reports");
    expect(resolveActiveHref(nav, { pathname: "/operator/algo-sin-item" })).toBeNull();
    expect(resolveActiveHref(nav, { pathname: null })).toBeNull();
  });

  it("acepta la nav ya traducida (sólo mira href)", () => {
    const translated = [
      { href: "/operator", label: "Resumen" },
      { label: "Contabilidad", children: [{ href: "/operator/contabilidad", label: "Gastos" }] },
    ];
    expect(resolveActiveHref(translated, { pathname: "/operator/contabilidad/x" })).toBe(
      "/operator/contabilidad",
    );
  });
});
