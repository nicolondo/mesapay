// Exportación de la vista actual del análisis de ventas a CSV y a Excel —
// sin base de datos: recibe el análisis ya cargado (con los mismos filtros de
// la pantalla) y arma secciones tipadas. El CSV usa el dialecto de los
// reportes contables (`;`, coma decimal, BOM y guardia contra fórmulas); el
// Excel, una hoja por sección con números de verdad (no texto) y formato.
import ExcelJS from "exceljs";
import type { Locale } from "@/i18n/config";
import { CSV_BOM, centsToCsv, csvText } from "@/lib/erp/reports/csv";
import { NO_WAITER, type Dimension } from "./filters";
import { buildHeatmap } from "./heatmap";
import { buildTrend, pointTicket } from "./trend";
import { share, variation, type KpiKey } from "./metrics";
import type { SalesAnalysis } from "./types";
import { categoryName, channelLabel, dimName, dimValueLabel, methodLabel, periodLabel, tableName, type Tr } from "./dimLabels";
import { bucketLabel, fmtRange, hourLabel, weekdayName } from "./labels";

export type ExportCell =
  | { kind: "money"; cents: number | null }
  | { kind: "int"; value: number | null }
  | { kind: "dec"; value: number | null }
  | { kind: "pct"; value: number | null }
  | { kind: "text"; value: string | null };

export type ExportSection = { key: string; title: string; headers: string[]; rows: ExportCell[][] };

const money = (cents: number | null | undefined): ExportCell => ({ kind: "money", cents: cents ?? null });
const int = (value: number | null | undefined): ExportCell => ({ kind: "int", value: value ?? null });
const dec = (value: number | null | undefined): ExportCell => ({ kind: "dec", value: value ?? null });
const pct = (value: number | null | undefined): ExportCell => ({ kind: "pct", value: value ?? null });
const text = (value: string | null | undefined): ExportCell => ({ kind: "text", value: value ?? null });

export type ExportContext = {
  t: Tr;
  locale: Locale;
  counterMode: boolean;
  restaurantName: string;
};

/** Las secciones de la vista actual, en el orden de la pantalla. */
export function buildExportSections(a: SalesAnalysis, ctx: ExportContext): ExportSection[] {
  const { t, locale, counterMode } = ctx;
  const hasCompare = a.compare !== null;
  const labelCtx = { t, locale, options: a.options, counterMode };
  const filtersText = a.filters.dimOrder
    .filter((d) => a.filters.dims[d] !== undefined)
    .map((d: Dimension) => `${dimName(d, t)}: ${dimValueLabel(d, a.filters.dims[d] as never, labelCtx)}`)
    .join(" · ");

  const kpiRows: [KpiKey, string, "money" | "int" | "dec"][] = [
    ["netCents", t("kpi.net"), "money"],
    ["grossCents", t("kpi.gross"), "money"],
    ["taxCents", t("kpi.tax"), "money"],
    ["tipCents", t("kpi.tips"), "money"],
    ["discountCents", t("export.discounts"), "money"],
    ["compsCents", t("export.comps"), "money"],
    ["returnsCents", t("kpi.returns"), "money"],
    ["netAfterReturnsCents", t("export.netAfterReturns"), "money"],
    ["orders", t("kpi.orders"), "int"],
    ["diners", t("kpi.diners"), "int"],
    ["avgTicketCents", t("kpi.avgTicket"), "money"],
    ["avgPerDinerCents", t("kpi.avgPerDiner"), "money"],
    ["unitsPerOrder", t("kpi.unitsPerOrder"), "dec"],
    ["medianTableMinutes", t("export.tableMinutes"), "int"],
  ];
  const cell = (kind: "money" | "int" | "dec", v: number | null) => (kind === "money" ? money(v) : kind === "int" ? int(v) : dec(v));
  const summary: ExportSection = {
    key: "summary",
    title: t("export.summary"),
    headers: [t("export.indicator"), t("export.current"), ...(hasCompare ? [t("export.comparison"), t("variation")] : [])],
    rows: [
      [text(t("export.restaurant")), text(ctx.restaurantName)],
      [text(t("periodLabel")), text(`${periodLabel(a.filters, t, locale)} (${fmtRange(a.range, locale)})`)],
      ...(a.compareRange ? [[text(t("compareLabel")), text(fmtRange(a.compareRange, locale))]] : []),
      [text(t("activeFilters")), text(filtersText || t("all"))],
      [text(t("export.businessDay")), text(t("businessDayHint", { hour: String(a.cutoffHour).padStart(2, "0") }))],
      ...kpiRows.map(([key, label, kind]) => {
        const cur = a.kpis[key] as number | null;
        const prev = a.compareKpis ? (a.compareKpis[key] as number | null) : null;
        return [text(label), cell(kind, cur), ...(hasCompare ? [cell(kind, prev), pct(variation(cur, prev))] : [])];
      }),
    ],
  };

  const points = buildTrend({
    rows: a.current.trend,
    range: a.range,
    compareRows: a.compare?.trend ?? null,
    compareRange: a.compareRange,
    granularity: a.granularity,
    cutoffHour: a.cutoffHour,
  });
  const bucketText = (key: string) => {
    const l = bucketLabel(key, a.granularity, locale);
    return l.weekOf ? t("weekOf", { date: l.weekOf }) : l.long;
  };
  const trend: ExportSection = {
    key: "trend",
    title: t("trend.title"),
    headers: [
      t(`granularity.${a.granularity}`), t("kpi.net"), t("kpi.orders"), t("kpi.diners"), t("kpi.avgTicket"),
      ...(hasCompare ? [t("trend.compareNet"), t("variation")] : []),
    ],
    rows: points.map((p) => [
      text(bucketText(p.bucket)), money(p.netCents), int(p.orders), int(p.diners), money(pointTicket(p.netCents, p.orders)),
      ...(hasCompare ? [money(p.compareNetCents), pct(variation(p.netCents, p.compareNetCents))] : []),
    ]),
  };

  const catLabel = new Map(a.options.categories.map((c) => [c.id, categoryName(c, t)]));
  const prevProduct = new Map((a.compare?.products ?? []).map((p) => [p.key, p]));
  const totalNet = a.current.products.reduce((s, p) => s + p.netCents, 0);
  const margins = new Map((a.engineering?.dishes ?? []).map((d) => [d.menuItemId, d]));
  const products: ExportSection = {
    key: "products",
    title: t("products.title"),
    headers: [
      t("products.product"), t("dim.categoria"), t("units"), t("kpi.net"), t("export.listValue"), t("products.share"),
      t("products.avgPrice"), t("kpi.orders"),
      ...(hasCompare ? [t("variation")] : []),
      ...(a.engineering ? [t("eng.unitCost"), t("products.unitMargin"), t("export.marginPct"), t("eng.quadrant")] : []),
    ],
    rows: a.current.products.map((p) => {
      const d = p.menuItemId ? margins.get(p.menuItemId) : undefined;
      return [
        text(p.name),
        text(p.categoryId ? catLabel.get(p.categoryId) ?? null : t("freeLines")),
        int(p.units), money(p.netCents), money(p.grossCents), pct(share(p.netCents, totalNet)),
        money(p.units > 0 ? Math.round(p.netCents / p.units) : null), int(p.orders),
        ...(hasCompare ? [pct(variation(p.netCents, prevProduct.get(p.key)?.netCents ?? null))] : []),
        ...(a.engineering
          ? [
              money(d ? Math.round(d.unitCostCents) : null),
              money(d ? Math.round(d.unitMarginCents) : null),
              pct(d ? d.marginPct : null),
              text(d ? t(`eng.q.${d.quadrant}.name`) : null),
            ]
          : []),
      ];
    }),
  };

  const totalCat = a.current.categories.reduce((s, c) => s + c.netCents, 0);
  const prevCat = new Map((a.compare?.categories ?? []).map((c) => [c.categoryId ?? "", c]));
  const categories: ExportSection = {
    key: "categories",
    title: t("products.categories"),
    headers: [t("dim.categoria"), t("units"), t("kpi.net"), t("products.share"), t("kpi.orders"), ...(hasCompare ? [t("variation")] : [])],
    rows: a.current.categories.map((c) => [
      text(categoryName(c, t)), int(c.units), money(c.netCents), pct(share(c.netCents, totalCat)), int(c.orders),
      ...(hasCompare ? [pct(variation(c.netCents, prevCat.get(c.categoryId ?? "")?.netCents ?? null))] : []),
    ]),
  };

  const modifiers: ExportSection = {
    key: "modifiers",
    title: t("products.modifiers"),
    headers: [t("export.modifierGroup"), t("export.modifierOption"), t("units"), t("export.productsCount")],
    rows: a.modifiers.map((m) => [text(m.group ?? t("products.modifierNoGroup")), text(m.option), int(m.units), int(m.products)]),
  };

  const prevWaiter = new Map((a.compare?.waiters ?? []).map((w) => [w.waiterId ?? NO_WAITER, w]));
  const team: ExportSection = {
    key: "team",
    title: t("team.title"),
    headers: [
      t("team.waiter"), t("kpi.net"), t("kpi.orders"), t("kpi.avgTicket"), t("kpi.diners"), t("kpi.tips"), t("team.commission"),
      ...(hasCompare ? [t("variation")] : []),
    ],
    rows: a.current.waiters.map((w) => [
      text(w.waiterId ? w.name : t("noWaiter")), money(w.netCents), int(w.orders),
      money(w.orders > 0 ? Math.round(w.netCents / w.orders) : null), int(w.diners), money(w.tipCents), money(w.commissionCents),
      ...(hasCompare ? [pct(variation(w.netCents, prevWaiter.get(w.waiterId ?? NO_WAITER)?.netCents ?? null))] : []),
    ]),
  };

  const totalMethods = a.current.methods.reduce((s, m) => s + m.amountCents, 0);
  const methods: ExportSection = {
    key: "methods",
    title: t("mix.methods"),
    headers: [t("dim.pago"), t("mix.collected"), t("products.share"), t("kpi.tips"), t("export.payments"), t("kpi.orders")],
    rows: a.current.methods.map((m) => [
      text(methodLabel(m.method, t)), money(m.amountCents), pct(share(m.amountCents, totalMethods)), money(m.tipCents), int(m.payments), int(m.orders),
    ]),
  };

  const totalChannels = a.current.channels.reduce((s, c) => s + c.netCents, 0);
  const channels: ExportSection = {
    key: "channels",
    title: t("mix.channels"),
    headers: [t("dim.canal"), t("kpi.net"), t("products.share"), t("kpi.orders"), t("kpi.diners"), t("kpi.avgTicket")],
    rows: a.current.channels.map((c) => [
      text(channelLabel(c.channel, t, counterMode)), money(c.netCents), pct(share(c.netCents, totalChannels)), int(c.orders), int(c.diners),
      money(c.orders > 0 ? Math.round(c.netCents / c.orders) : null),
    ]),
  };

  const tables: ExportSection = {
    key: "tables",
    title: t("mix.tables"),
    headers: [t("dim.mesa"), t("kpi.net"), t("kpi.orders"), t("kpi.diners")],
    rows: a.tables.map((x) => [text(tableName(x, t)), money(x.netCents), int(x.orders), int(x.diners)]),
  };

  const heat = buildHeatmap(a.heat, a.cutoffHour);
  const heatmap: ExportSection = {
    key: "heatmap",
    title: t("heat.title"),
    headers: [t("dim.dia"), t("dim.hora"), t("kpi.net"), t("kpi.orders")],
    rows: heat.cells.flat().filter((c) => c.orders > 0).map((c) => [
      text(weekdayName(c.dow, locale, "long")), text(hourLabel(c.hour)), money(c.netCents), int(c.orders),
    ]),
  };

  const sections = [summary, trend, products, categories, modifiers, team, methods, channels];
  if (!counterMode) sections.push(tables);
  sections.push(heatmap);
  if (a.orders) {
    sections.push({
      key: "orders",
      title: t("orders.title"),
      headers: [
        t("orders.paidAt"), t("orders.account"), t("orders.where"), t("team.waiter"), t("kpi.diners"), t("units"),
        t("kpi.net"), t("kpi.tips"), t("orders.collected"), t("dim.pago"),
      ],
      rows: a.orders.map((o) => [
        text(o.paidAt.toISOString()),
        text(o.shortCode),
        text(o.channel === "salon" && !counterMode ? tableName({ number: o.tableNumber, label: o.tableLabel }, t) : channelLabel(o.channel, t, counterMode)),
        text(o.waiterName ?? t("noWaiter")),
        int(o.diners), int(o.units), money(o.netCents), money(o.tipCents), money(o.totalCents),
        text(o.methods.map((m) => methodLabel(m, t)).join(", ")),
      ]),
    });
  }
  return sections;
}

// ── CSV ────────────────────────────────────────────────────────────────────

function csvValue(c: ExportCell): string {
  switch (c.kind) {
    case "money":
      return c.cents === null ? "" : centsToCsv(c.cents);
    case "int":
      return c.value === null ? "" : String(Math.round(c.value));
    case "dec":
      return c.value === null ? "" : c.value.toFixed(2).replace(".", ",");
    case "pct":
      return c.value === null ? "" : (c.value * 100).toFixed(1).replace(".", ",");
    case "text":
      return c.value === null ? "" : csvText(c.value);
  }
}

/**
 * Un solo archivo con las secciones apiladas: título, encabezados, filas y
 * una línea en blanco. Montos en unidades de moneda con dos decimales;
 * porcentajes como número (12,5 = 12,5 %).
 */
export function sectionsToCsv(sections: ExportSection[]): string {
  const lines: string[] = [];
  for (const s of sections) {
    lines.push(csvText(s.title));
    lines.push(s.headers.map(csvText).join(";"));
    for (const row of s.rows) lines.push(row.map(csvValue).join(";"));
    lines.push("");
  }
  return CSV_BOM + lines.join("\r\n");
}

// ── Excel ──────────────────────────────────────────────────────────────────

const ZERO_DECIMAL = new Set(["COP", "CLP", "PYG", "JPY"]);

/** Nombre de hoja válido en Excel: sin `[]:*?/\` y de máximo 31 caracteres, único. */
function sheetName(title: string, used: Set<string>): string {
  const base = title.replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31) || "Hoja";
  let name = base;
  for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base.slice(0, 28)} ${i}`;
  used.add(name.toLowerCase());
  return name;
}

/** Texto que empieza como fórmula se guarda como texto, nunca como fórmula. */
function safeText(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

export async function sectionsToXlsx(sections: ExportSection[], currency: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "MESAPAY";
  const moneyFmt = ZERO_DECIMAL.has(currency.toUpperCase()) ? "#,##0" : "#,##0.00";
  const used = new Set<string>();
  for (const s of sections) {
    const ws = wb.addWorksheet(sheetName(s.title, used), { views: [{ state: "frozen", ySplit: 1 }] });
    ws.addRow(s.headers);
    ws.getRow(1).font = { bold: true };
    for (const row of s.rows) {
      const added = ws.addRow(
        row.map((c) => {
          switch (c.kind) {
            case "money":
              return c.cents === null ? null : c.cents / 100;
            case "text":
              return c.value === null ? null : safeText(c.value);
            default:
              return c.value;
          }
        }),
      );
      row.forEach((c, i) => {
        const cell = added.getCell(i + 1);
        if (c.kind === "money") cell.numFmt = moneyFmt;
        else if (c.kind === "pct") cell.numFmt = "0.0%";
        else if (c.kind === "dec") cell.numFmt = "0.00";
        else if (c.kind === "int") cell.numFmt = "#,##0";
      });
    }
    ws.columns.forEach((col, i) => {
      const width = Math.max(
        s.headers[i]?.length ?? 8,
        ...s.rows.map((r) => {
          const c = r[i];
          return c?.kind === "text" ? Math.min(48, c.value?.length ?? 0) : 14;
        }),
      );
      col.width = Math.min(50, Math.max(10, width + 2));
    });
  }
  const out = await wb.xlsx.writeBuffer();
  return Buffer.isBuffer(out) ? out : Buffer.from(out as ArrayBuffer);
}

/** Nombre de archivo de la exportación. */
export function exportFilename(a: Pick<SalesAnalysis, "range">, ext: "csv" | "xlsx"): string {
  return `ventas-${a.range.from}-a-${a.range.to}.${ext}`;
}
