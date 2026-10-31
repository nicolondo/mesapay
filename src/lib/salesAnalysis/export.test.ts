import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { buildExportSections, exportFilename, sectionsToCsv, sectionsToXlsx } from "./export";
import { parseSalesFilters } from "./filters";
import { deriveKpis, EMPTY_TOTALS } from "./metrics";
import type { SalesAnalysis } from "./types";

/** Traductor de prueba: devuelve la clave (y las variables), así se verifica estructura y no textos. */
const t = (key: string, values?: Record<string, string | number>) =>
  values ? `${key}(${Object.values(values).join(",")})` : key;

function analysis(patch: Partial<SalesAnalysis> = {}): SalesAnalysis {
  const totals = { ...EMPTY_TOTALS, orders: 2, diners: 5, units: 3, grossCents: 10_000_000, discountCents: 400_000, taxCents: 0, netCents: 9_600_000, tipCents: 600_000, compsCents: 900_000 };
  const prevTotals = { ...totals, orders: 1, netCents: 8_000_000 };
  const period = (range: { from: string; to: string }, net: number) => ({
    range,
    totals: { ...totals, netCents: net },
    returns: null,
    duration: { medianMinutes: null, measured: 0, eligible: 0 },
    trend: [{ bucket: range.from, netCents: net, orders: 2, diners: 5 }],
    products: [
      { key: "m1", menuItemId: "m1", name: "=HYPERLINK(\"x\")", categoryId: "c1", units: 2, netCents: 6_000_000, grossCents: 6_400_000, orders: 2 },
      { key: "libre:Catering", menuItemId: null, name: "Catering", categoryId: null, units: 1, netCents: net - 6_000_000, grossCents: 3_600_000, orders: 1 },
    ],
    categories: [{ categoryId: "c1", label: "Fuertes", parentLabel: null, units: 2, netCents: 6_000_000, orders: 2 }],
    waiters: [{ waiterId: "w1", name: "Ana", netCents: net, orders: 2, diners: 5, tipCents: 600_000, commissionCents: 24_000 }],
    methods: [{ method: "cash" as const, amountCents: 10_200_000, tipCents: 600_000, payments: 3, orders: 2 }],
    channels: [{ channel: "salon" as const, netCents: net, orders: 2, diners: 5 }],
  });
  return {
    filters: parseSalesFilters(new URLSearchParams("periodo=rango&desde=2026-10-14&hasta=2026-10-14&mesero=w1")),
    today: "2026-10-31",
    cutoffHour: 5,
    counterMode: false,
    itemFilter: false,
    range: { from: "2026-10-14", to: "2026-10-14" },
    compareRange: { from: "2026-10-13", to: "2026-10-13" },
    granularity: "hora",
    current: period({ from: "2026-10-14", to: "2026-10-14" }, 9_600_000),
    compare: period({ from: "2026-10-13", to: "2026-10-13" }, 8_000_000),
    kpis: deriveKpis(totals, null, null),
    compareKpis: deriveKpis(prevTotals, null, null),
    heat: [{ dow: 3, hour: 20, netCents: 9_600_000, orders: 2 }],
    tables: [{ tableId: "t1", number: 4, label: null, netCents: 9_600_000, orders: 2, diners: 5 }],
    modifiers: [{ group: "Término", option: "Medio", units: 2, products: 1 }],
    orders: [{
      id: "o1", shortCode: "ABC123", paidAt: new Date("2026-10-15T01:30:00Z"), channel: "salon", tableNumber: 4, tableLabel: null,
      waiterName: "Ana", diners: 2, units: 2, netCents: 4_800_000, tipCents: 300_000, totalCents: 5_400_000, methods: ["cash"],
    }],
    ordersTruncated: false,
    unsold: [],
    engineering: null,
    options: { waiters: [{ id: "w1", name: "Ana", disabled: false }], categories: [{ id: "c1", label: "Fuertes", parentLabel: null }], products: [], tables: [] },
    ...patch,
  };
}

const ctx = { t, locale: "es" as const, counterMode: false, restaurantName: "Son y Melona" };

describe("secciones de la vista actual", () => {
  const sections = buildExportSections(analysis(), ctx);

  it("todas las secciones de la pantalla, en orden; cuentas del día cuando es un día", () => {
    expect(sections.map((s) => s.key)).toEqual([
      "summary", "trend", "products", "categories", "modifiers", "team", "methods", "channels", "tables", "heatmap", "orders",
    ]);
    expect(buildExportSections(analysis({ orders: null, counterMode: true }), { ...ctx, counterMode: true }).map((s) => s.key))
      .not.toEqual(expect.arrayContaining(["orders", "tables"]));
  });

  it("el resumen dice comercio, período, comparación y filtros, y trae la variación", () => {
    const summary = sections[0]!;
    expect(summary.headers).toEqual(["export.indicator", "export.current", "export.comparison", "variation"]);
    const texts = summary.rows.map((r) => (r[0]?.kind === "text" ? r[0].value : null));
    expect(texts).toEqual(expect.arrayContaining(["export.restaurant", "periodLabel", "compareLabel", "activeFilters", "kpi.net"]));
    const filtersRow = summary.rows.find((r) => r[0]?.kind === "text" && r[0].value === "activeFilters")!;
    expect(filtersRow[1]).toEqual({ kind: "text", value: "dim.mesero: Ana" });
    const net = summary.rows.find((r) => r[0]?.kind === "text" && r[0].value === "kpi.net")!;
    expect(net.slice(1)).toEqual([
      { kind: "money", cents: 9_600_000 },
      { kind: "money", cents: 8_000_000 },
      { kind: "pct", value: 0.2 },
    ]);
  });

  it("la tendencia trae los 24 baldes del día con su comparación", () => {
    expect(sections[1]!.rows).toHaveLength(24);
  });
});

describe("CSV", () => {
  const csv = sectionsToCsv(buildExportSections(analysis(), ctx));

  it("BOM, punto y coma, coma decimal y secciones separadas por una línea en blanco", () => {
    expect(csv.startsWith("﻿")).toBe(true);
    const lines = csv.slice(1).split("\r\n");
    expect(lines[0]).toBe("export.summary");
    expect(lines[1]).toBe("export.indicator;export.current;export.comparison;variation");
    expect(lines).toContain("kpi.net;96000,00;80000,00;20,0");
    expect(lines.filter((l) => l === "").length).toBeGreaterThanOrEqual(10);
  });

  it("un nombre que empieza como fórmula se escapa", () => {
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).not.toMatch(/(^|;)=HYPERLINK/m);
  });
});

describe("Excel", () => {
  it("una hoja por sección, con números de verdad y formato de moneda/porcentaje", async () => {
    const buffer = await sectionsToXlsx(buildExportSections(analysis(), ctx), "COP");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toHaveLength(11);
    const summary = wb.worksheets[0]!;
    expect(summary.getRow(1).getCell(1).value).toBe("export.indicator");
    const netRow = summary.getRows(1, summary.rowCount)!.find((r) => r.getCell(1).value === "kpi.net")!;
    expect(netRow.getCell(2).value).toBe(96_000);
    expect(netRow.getCell(2).numFmt).toBe("#,##0");
    expect(netRow.getCell(4).value).toBeCloseTo(0.2);
    expect(netRow.getCell(4).numFmt).toBe("0.0%");
    const products = wb.worksheets[2]!;
    expect(products.getRow(2).getCell(1).value).toBe(`'=HYPERLINK("x")`);
  });

  it("moneda con centavos: dos decimales", async () => {
    const buffer = await sectionsToXlsx(buildExportSections(analysis(), ctx), "MXN");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const netRow = wb.worksheets[0]!.getRows(1, 40)!.find((r) => r.getCell(1).value === "kpi.net")!;
    expect(netRow.getCell(2).numFmt).toBe("#,##0.00");
  });

  it("nombre de archivo con el rango", () => {
    expect(exportFilename(analysis(), "xlsx")).toBe("ventas-2026-10-14-a-2026-10-14.xlsx");
  });
});
