/**
 * Exportación del informe de proveedores — Excel (.xlsx) y CSV, con los
 * MISMOS filtros y orden de la pantalla pero sin paginar: van todas las
 * filas filtradas. Sin base de datos: recibe las filas ya calculadas.
 *
 *  · Excel: hoja «Proveedores» (encabezado congelado y con autofiltro,
 *    montos como números con formato de miles, fechas como fechas, fila
 *    de total) y hoja «Información» (comercio, período, divisor, base,
 *    filtros y la definición del promedio), aparte para no ensuciar la de
 *    datos — mismo patrón que el Excel de la exógena.
 *  · CSV: el dialecto de los reportes contables (`csv.ts`: `;`, coma
 *    decimal, BOM, guardia contra fórmulas) con una primera línea que dice
 *    período y base.
 */
import ExcelJS from "exceljs";
import type { Locale } from "@/i18n/config";
import { formatDate, isZeroDecimalCurrency } from "@/lib/format";
import { buildReportCsv, type CsvValue } from "./csv";
import { conditionLabel, monthLabel, periodLabel, type Tr } from "./supplierReportLabels";
import {
  type SupplierReportQuery,
  type SupplierReportRow,
  type SupplierReportTotals,
  type SupplierReportPeriod,
} from "./supplierReport";

export type SupplierExportContext = {
  /** Traductor del namespace `opSupplierReport`. */
  t: Tr;
  locale: Locale;
  currency: string;
  business: { name: string; taxId: string | null };
  query: SupplierReportQuery;
  /** Sólo para tests deterministas. */
  now?: Date;
};

/** Nombre del archivo: `proveedores-2025-11-a-2026-10.xlsx`. */
export function supplierReportFilename(period: Pick<SupplierReportPeriod, "fromMonth" | "toMonth">, ext: "csv" | "xlsx"): string {
  return `proveedores-${period.fromMonth}-a-${period.toMonth}.${ext}`;
}

/** Encabezados de las columnas, en el orden de los datos. */
export function supplierExportHeaders(t: Tr): string[] {
  return [
    t("colSupplier"),
    t("colDocType"),
    t("colDocNumber"),
    t("colDv"),
    t("colCondition"),
    t("colTermsDays"),
    t("colAverage"),
    t("colTotal"),
    t("colInvoices"),
    t("colLastPurchase"),
    t("colPayable"),
    t("colAgreements"),
    t("colStatus"),
  ];
}

/** Índices (0-based) de las columnas de plata, de enteros y de fecha. */
const MONEY_COLS = new Set([6, 7, 10, 11]);
const INT_COLS = new Set([5, 8]);
const DATE_COL = 9;

type Cell = string | number | Date | null;

/** Una fila de datos: montos en CENTAVOS (cada formato los convierte). */
function rowCells(r: SupplierReportRow, t: Tr): Cell[] {
  return [
    r.name,
    r.document?.type ?? null,
    r.document?.number ?? null,
    r.document?.dv ?? null,
    conditionLabel(t, r.creditDays),
    r.creditDays ?? 0,
    r.averageCents,
    r.totalCents,
    r.invoices,
    r.lastPurchase ? new Date(`${r.lastPurchase}T00:00:00Z`) : null,
    r.payableCents,
    r.agreementCents,
    r.active ? t("active") : t("inactive"),
  ];
}

function totalCells(totals: SupplierReportTotals, t: Tr): Cell[] {
  return [
    t("totalRow", { n: totals.suppliers }),
    null,
    null,
    null,
    null,
    null,
    totals.averageCents,
    totals.totalCents,
    totals.invoices,
    null,
    totals.payableCents,
    totals.agreementCents,
    null,
  ];
}

function basisLabel(t: Tr, q: SupplierReportQuery): string {
  return q.basis === "total" ? t("basisTotal") : t("basisCost");
}

function includeLabel(t: Tr, q: SupplierReportQuery): string {
  return q.includeExpenses ? t("includeAll") : t("includePurchases");
}

/* ─────────────────────────────────── CSV ─────────────────────────────────── */

/** Celda del CSV: los montos viajan en centavos (`centsToCsv`); el resto como texto. */
function csvCell(v: Cell, idx: number): CsvValue {
  if (v === null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "number") return MONEY_COLS.has(idx) ? v : String(v);
  return v;
}

export function supplierReportCsv(
  rows: readonly SupplierReportRow[],
  totals: SupplierReportTotals,
  ctx: SupplierExportContext,
): string {
  const { t, query, locale } = ctx;
  return buildReportCsv({
    headers: supplierExportHeaders(t),
    rows: [...rows.map((r) => rowCells(r, t)), totalCells(totals, t)].map((cells) => cells.map(csvCell)),
    note: t("csvNote", {
      period: periodLabel(query.period, locale),
      months: query.period.months,
      basis: basisLabel(t, query),
      include: includeLabel(t, query),
    }),
  });
}

/* ────────────────────────────────── Excel ────────────────────────────────── */

const FILL_HEADER = "FFF1EEE8";
const solid = (argb: string): ExcelJS.Fill => ({ type: "pattern", pattern: "solid", fgColor: { argb } });

/** Nombre de hoja válido en Excel: sin `[]:*?/\` y de máximo 31 caracteres. */
function sheetName(title: string): string {
  return title.replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31) || "Hoja";
}

export async function supplierReportXlsx(
  rows: readonly SupplierReportRow[],
  totals: SupplierReportTotals,
  ctx: SupplierExportContext,
): Promise<Buffer> {
  const { t, query, locale } = ctx;
  const now = ctx.now ?? new Date();
  const moneyFmt = isZeroDecimalCurrency(ctx.currency) ? "#,##0" : "#,##0.00";
  const wb = new ExcelJS.Workbook();
  wb.creator = "MESAPAY";
  wb.created = now;

  /* ── Datos ── */
  const ws = wb.addWorksheet(sheetName(t("sheetData")), { views: [{ state: "frozen", ySplit: 1 }] });
  const headers = supplierExportHeaders(t);
  ws.addRow(headers);
  const dataRows = rows.map((r) => rowCells(r, t));
  const writeRow = (cells: Cell[]) => {
    const row = ws.addRow(cells.map((v, j) => (typeof v === "number" && MONEY_COLS.has(j) ? v / 100 : v)));
    cells.forEach((v, j) => {
      const cell = row.getCell(j + 1);
      if (MONEY_COLS.has(j)) cell.numFmt = moneyFmt;
      else if (INT_COLS.has(j)) cell.numFmt = "#,##0";
      else if (j === DATE_COL) cell.numFmt = "yyyy-mm-dd";
      // Documento como TEXTO: un NIT no es una cifra (ceros a la izquierda, sin miles).
      else if (typeof v === "string") cell.numFmt = "@";
    });
    return row;
  };
  dataRows.forEach(writeRow);
  const totalRow = writeRow(totalCells(totals, t));
  totalRow.font = { bold: true };
  totalRow.eachCell((c) => {
    c.border = { top: { style: "thin", color: { argb: "FFBFB8AD" } } };
  });

  const header = ws.getRow(1);
  header.font = { bold: true };
  header.alignment = { vertical: "top", wrapText: true };
  header.eachCell((c) => {
    c.fill = solid(FILL_HEADER);
    c.border = { bottom: { style: "thin", color: { argb: "FFBFB8AD" } } };
  });
  headers.forEach((h, i) => {
    const longest = Math.max(
      ...dataRows.map((r) => {
        const v = r[i];
        if (v === null || v === undefined) return 0;
        if (v instanceof Date) return 10;
        if (typeof v === "number") return (MONEY_COLS.has(i) ? v / 100 : v).toLocaleString("en").length + 1;
        return v.length;
      }),
      0,
    );
    ws.getColumn(i + 1).width = Math.min(48, Math.max(10, Math.min(h.length, 18), longest) + 2);
  });
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1 + dataRows.length, column: headers.length } };

  /* ── Información ── */
  const info = wb.addWorksheet(sheetName(t("sheetInfo")));
  const conditionFilter =
    query.condition === "contado" ? t("condCash") : query.condition === "credito" ? t("condCredit") : t("condAll");
  const infoRows: [string, string | number][] = [
    [t("infoBusiness"), ctx.business.name],
    [t("infoTaxId"), ctx.business.taxId ?? ""],
    [t("infoPeriod"), periodLabel(query.period, locale)],
    [t("infoMonths"), query.period.months],
    [t("infoBasis"), basisLabel(t, query)],
    [t("infoInclude"), includeLabel(t, query)],
    [t("infoCondition"), conditionFilter],
    ...(query.q ? ([[t("infoSearch"), query.q]] as [string, string][]) : []),
    [t("infoRows"), rows.length],
    [t("infoGenerated"), formatDate(now, { locale })],
  ];
  for (const [label, value] of infoRows) {
    const row = info.addRow([label, value]);
    row.getCell(1).font = { bold: true };
    row.getCell(2).alignment = { horizontal: "left" };
    if (typeof value === "string") row.getCell(2).numFmt = "@";
  }
  info.addRow([]);
  const notes = [
    t("definitionBody", {
      from: monthLabel(query.period.fromMonth, locale),
      to: monthLabel(query.period.toMonth, locale),
      months: query.period.months,
    }),
    query.basis === "total" ? t("definitionTotal") : t("definitionCost"),
    query.includeExpenses ? t("definitionAll") : t("definitionPurchases"),
    t("definitionAgreements"),
    ...(query.period.includesCurrentMonth ? [t("currentMonthWarning")] : []),
    t("note"),
  ];
  for (const n of notes) {
    const row = info.addRow([n]);
    info.mergeCells(row.number, 1, row.number, 2);
    row.getCell(1).alignment = { wrapText: true, vertical: "top" };
    row.height = 15 * Math.max(1, Math.ceil(n.length / 95));
  }
  info.getColumn(1).width = 30;
  info.getColumn(2).width = 70;

  const out = await wb.xlsx.writeBuffer();
  return Buffer.isBuffer(out) ? out : Buffer.from(out as ArrayBuffer);
}
