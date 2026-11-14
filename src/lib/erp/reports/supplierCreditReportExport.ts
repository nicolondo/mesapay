/**
 * Exportación del reporte «Notas crédito de proveedores» — Excel (.xlsx) y
 * CSV, con los mismos filtros de la pantalla. Excel: hojas «Resumen» (por
 * tipo y por mes), «Proveedores», «Acuerdos» y «Notas» (el detalle), montos
 * como números con formato de miles; CSV: el detalle en el dialecto de los
 * reportes contables (`csv.ts`).
 */
import ExcelJS from "exceljs";
import { isZeroDecimalCurrency } from "@/lib/format";
import { SUPPLIER_CREDIT_NOTE_KINDS, KIND_LABEL_KEY } from "../supplierCreditNotes";
import { buildReportCsv, type CsvValue } from "./csv";
import type { ReportPeriod } from "./period";
import type { SupplierCreditReport } from "./supplierCreditReport";

type Tr = (key: string, values?: Record<string, string | number>) => string;

export type SupplierCreditExportContext = {
  /** Traductor del namespace `opSupplierCredit`. */
  t: Tr;
  currency: string;
  business: { name: string; taxId: string | null };
  period: ReportPeriod;
};

export function supplierCreditFilename(period: ReportPeriod, ext: "csv" | "xlsx"): string {
  return `notas-credito-proveedores-${period.desde}-a-${period.hasta}.${ext}`;
}

/** Centavos → unidades de la moneda (el Excel lleva números, no texto). */
const pesos = (cents: number) => cents / 100;

export function supplierCreditCsv(report: SupplierCreditReport, ctx: SupplierCreditExportContext): string {
  const { t } = ctx;
  const rows: CsvValue[][] = report.rows.map((r) => [
    r.date,
    r.number,
    r.supplierName,
    r.supplierTaxId ?? "",
    t(KIND_LABEL_KEY[r.kind]),
    r.agreement ?? "",
    r.baseCents,
    r.ivaCents,
    r.incCents,
    r.totalCents,
  ]);
  return buildReportCsv({
    note: t("csvNote", { desde: ctx.period.desde, hasta: ctx.period.hasta }),
    headers: [
      t("colDate"),
      t("colNumber"),
      t("colSupplier"),
      t("colTaxId"),
      t("colKind"),
      t("colAgreement"),
      t("colBase"),
      t("colIva"),
      t("colInc"),
      t("colTotal"),
    ],
    rows,
  });
}

export async function supplierCreditXlsx(report: SupplierCreditReport, ctx: SupplierCreditExportContext): Promise<Buffer> {
  const { t, currency } = ctx;
  const money = (c: number) => pesos(c);
  const fmt = isZeroDecimalCurrency(currency) ? "#,##0" : "#,##0.00";
  const wb = new ExcelJS.Workbook();
  wb.creator = "MESAPAY";

  const sheet = (name: string, headers: string[], data: (string | number | Date | null)[][], moneyCols: number[]) => {
    const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
    ws.addRow(headers).font = { bold: true };
    for (const r of data) ws.addRow(r);
    for (const c of moneyCols) ws.getColumn(c + 1).numFmt = fmt;
    ws.columns.forEach((col, i) => {
      col.width = Math.min(48, Math.max(12, (headers[i] ?? "").length + 4));
    });
    if (data.length > 0) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
    return ws;
  };

  // Resumen: por tipo y por mes.
  const summary = sheet(
    t("sheetSummary"),
    [t("colKind"), t("colCount"), t("colBase"), t("colIva"), t("colTotal")],
    [
      ...report.byKind.map((k) => [t(KIND_LABEL_KEY[k.kind]), k.count, money(k.baseCents), money(k.ivaCents), money(k.totalCents)]),
      [t("totalLabel"), report.totals.count, money(report.totals.baseCents), money(report.totals.ivaCents), money(report.totals.totalCents)],
    ],
    [2, 3, 4],
  );
  summary.lastRow!.font = { bold: true };
  summary.addRow([]);
  summary.addRow([t("colMonth"), ...SUPPLIER_CREDIT_NOTE_KINDS.map((k) => t(KIND_LABEL_KEY[k])), t("colTotal")]).font = { bold: true };
  for (const m of report.byMonth) {
    summary.addRow([m.month, ...SUPPLIER_CREDIT_NOTE_KINDS.map((k) => money(m.byKind[k])), money(m.totalCents)]);
  }

  sheet(
    t("sheetSuppliers"),
    [t("colSupplier"), t("colTaxId"), t("colCount"), ...SUPPLIER_CREDIT_NOTE_KINDS.map((k) => t(KIND_LABEL_KEY[k])), t("colTotal")],
    report.bySupplier.map((s) => [
      s.name,
      s.taxId,
      s.count,
      ...SUPPLIER_CREDIT_NOTE_KINDS.map((k) => money(s.byKind[k])),
      money(s.totalCents),
    ]),
    [3, 4, 5, 6, 7],
  );
  sheet(
    t("sheetAgreements"),
    [t("colSupplier"), t("colAgreement"), t("colCount"), t("colBase"), t("colTotal")],
    report.byAgreement.map((a) => [a.supplierName, a.agreement ?? t("noAgreement"), a.count, money(a.baseCents), money(a.totalCents)]),
    [3, 4],
  );
  sheet(
    t("sheetNotes"),
    [t("colDate"), t("colNumber"), t("colSupplier"), t("colTaxId"), t("colKind"), t("colAgreement"), t("colBase"), t("colIva"), t("colInc"), t("colTotal")],
    report.rows.map((r) => [
      new Date(`${r.date}T00:00:00Z`),
      r.number,
      r.supplierName,
      r.supplierTaxId,
      t(KIND_LABEL_KEY[r.kind]),
      r.agreement,
      money(r.baseCents),
      money(r.ivaCents),
      money(r.incCents),
      money(r.totalCents),
    ]),
    [6, 7, 8, 9],
  ).getColumn(1).numFmt = "yyyy-mm-dd";

  const info = wb.addWorksheet(t("sheetInfo"));
  info.addRow([t("infoBusiness"), ctx.business.name]);
  if (ctx.business.taxId) info.addRow([t("infoTaxId"), ctx.business.taxId]);
  info.addRow([t("infoPeriod"), `${ctx.period.desde} – ${ctx.period.hasta}`]);
  info.addRow([t("infoNote"), t("reportNote")]);
  info.getColumn(1).width = 22;
  info.getColumn(2).width = 80;

  return Buffer.from(await wb.xlsx.writeBuffer());
}
