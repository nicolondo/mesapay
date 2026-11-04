/**
 * Información exógena — Excel de revisión por formato (.xlsx). Lógica pura
 * salvo el volcado a ExcelJS: la ruta carga el reporte y llama
 * `buildFormatoXlsx`.
 *
 * El Excel lleva EXACTAMENTE los registros del XML: salen de
 * `buildFormatoRecords` (mismas cuantías menores, mismas omisiones, montos
 * en pesos enteros) y las columnas son los atributos del layout oficial
 * (`RECORD_LAYOUTS`) en su orden, con los encabezados del formato. Así se
 * puede revisar o pegar en el prevalidador de la DIAN sin que el Excel y el
 * XML diverjan.
 *
 * Hojas:
 *  · «Formato NNNN»: encabezado congelado + un registro por fila. Con
 *    incidencias que bloquean el XML, los terceros sin documento quedan al
 *    final, en rojo (no van al XML); las filas con avisos, en amarillo.
 *  · «Incidencias» (si el formato tiene): las del panel, con sus filas.
 *  · «Información»: informante, año, formato y versión, estado y notas.
 *    Va aparte para no ensuciar la hoja que se pega en el prevalidador.
 *
 * El 2276 no tiene XML (anexo T3.45 sin portar): su hoja es de trabajo,
 * con las columnas que MESAPAY calcula de la nómina.
 */

import ExcelJS from "exceljs";
import type { Locale } from "@/i18n/config";
import { formatDate } from "@/lib/format";
import { buildFormatoRecords, formatoBloqueado, type RecordSource } from "./download";
import { tieneXml, versionFormato, type FormatoExogena } from "./normativa";
import type { ExogenaIssue, ExogenaReport } from "./sources";
import { dianFileName, personAttrs, pesos, type RecordData } from "./xml";

export type Tr = (key: string, values?: Record<string, string | number>) => string;

/* ─────────────────────────── Hoja de datos (pura) ─────────────────────────── */

/**
 * Campos de identificación del tercero: mismo encabezado en todos los
 * formatos (`xlsx.col.<campo>`). Los demás son valores del formato y su
 * encabezado es propio (`xlsx.f<formato>.<campo>`).
 */
const IDENTITY_FIELDS = new Set([
  "cpt",
  "tdoc",
  "nid",
  "dv",
  "apl1",
  "apl2",
  "nom1",
  "nom2",
  "raz",
  "dir",
  "dpto",
  "mun",
  "pais",
]);

/** Columnas de la hoja de trabajo del 2276 (sin XML: lo que MESAPAY calcula). */
export const FIELDS_2276 = [
  "tdoc",
  "nid",
  "apl1",
  "apl2",
  "nom1",
  "nom2",
  "salario",
  "otros",
  "salud",
  "pension",
  "retefuente",
] as const;

/** Valores enteros sin separador de miles (porcentaje codificado del 1010). */
const PLAIN_INT_FIELDS = new Set(["por", "dec"]);

/** Clave i18n (namespace `opExogena`) del encabezado de un campo. */
export function headerKey(formato: FormatoExogena, field: string): string {
  return IDENTITY_FIELDS.has(field) ? `xlsx.col.${field}` : `xlsx.f${formato}.${field}`;
}

export type SheetRow = {
  /** Valores en el orden de `fields`: números en pesos, el resto texto. */
  values: (string | number)[];
  /** `omitted` = no va al XML (sin documento); `warning` = tiene un aviso. */
  status: "ok" | "warning" | "omitted";
  /** Incidencias del panel que tocan la fila. */
  issues: ExogenaIssue[];
};

export type FormatoSheet = {
  formato: FormatoExogena;
  version: number;
  hasXml: boolean;
  /** XML bloqueado por incidencias (el Excel se descarga igual). */
  blocked: boolean;
  fields: readonly string[];
  /** Registros del XML en su orden y, al final, las filas omitidas. */
  rows: SheetRow[];
  /** Cuántas filas son registros del XML (las primeras). */
  xmlRecords: number;
  /** ValorTotal de la cabecera del XML, en pesos. */
  valorTotal: number;
  /** Incidencias del formato con las filas de la hoja que tocan (1 = encabezado). */
  issues: { issue: ExogenaIssue; sheetRows: number[] }[];
};

type Built = { data: RecordData; sources: RecordSource[]; omitted: boolean };

/** La hoja del formato: mismos registros que el XML + omitidas + incidencias. */
export function buildFormatoSheet(
  report: ExogenaReport,
  formato: FormatoExogena,
  year: number,
  uvtPesos: number,
): FormatoSheet {
  let fields: readonly string[];
  let built: Built[];
  let xmlRecords: number;
  let valorTotal: number;

  if (tieneXml(formato)) {
    const r = buildFormatoRecords(report, formato, uvtPesos);
    fields = r.fields;
    built = [
      ...r.records.map((x) => ({ ...x, omitted: false })),
      ...r.omitted.map((x) => ({ ...x, omitted: true })),
    ];
    xmlRecords = r.records.length;
    valorTotal = r.valorTotal;
  } else {
    fields = FIELDS_2276;
    built = report.formats["2276"].map((r) => ({
      data: {
        tdoc: "",
        nid: "",
        ...personAttrs({ kind: "natural", name: r.name }),
        salario: pesos(r.salarioCents),
        otros: pesos(r.otrosCents),
        salud: pesos(r.saludCents),
        pension: pesos(r.pensionCents),
        retefuente: pesos(r.retefuenteCents),
      },
      sources: [{ name: r.name, code: "employee_missing_doc" }],
      omitted: false,
    }));
    xmlRecords = 0;
    valorTotal = built.reduce((s, b) => s + Number(b.data.salario) + Number(b.data.otros), 0);
  }

  const formatIssues = report.issues.filter((i) => i.format === formato);
  // Una incidencia toca la fila si alguno de sus terceros es el de la
  // incidencia (mismo nombre y mismo código: la regla de `terceroIssues`).
  const touches = (b: Built, i: ExogenaIssue) => b.sources.some((s) => s.name === i.name && s.code === i.code);

  const rows: SheetRow[] = built.map((b) => {
    const issues = formatIssues.filter((i) => touches(b, i));
    return {
      values: fields.map((f) => b.data[f] ?? ""),
      status: b.omitted ? "omitted" : issues.length > 0 ? "warning" : "ok",
      issues,
    };
  });

  return {
    formato,
    version: versionFormato(formato, year),
    hasXml: tieneXml(formato),
    blocked: formatoBloqueado(report, formato),
    fields,
    rows,
    xmlRecords,
    valorTotal,
    issues: formatIssues.map((issue) => ({
      issue,
      sheetRows: built.flatMap((b, idx) => (touches(b, issue) ? [idx + 2] : [])),
    })),
  };
}

/* ───────────────────────────── Libro (ExcelJS) ───────────────────────────── */

const FILL_HEADER = "FFF1EEE8";
const FILL_OMITTED = "FFFDE2E1";
const FILL_WARNING = "FFFFF3CD";

/** Nombre de hoja válido en Excel: sin `[]:*?/\` y de máximo 31 caracteres. */
function sheetName(title: string): string {
  return title.replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31) || "Hoja";
}

const solid = (argb: string): ExcelJS.Fill => ({ type: "pattern", pattern: "solid", fgColor: { argb } });

/** Ancho de columna por contenido, con tope; el encabezado se parte en líneas. */
function fitColumns(ws: ExcelJS.Worksheet, headers: string[], rows: (string | number | null)[][], max = 40) {
  let headerLines = 1;
  headers.forEach((h, i) => {
    const longest = Math.max(
      10,
      ...rows.map((r) => {
        const v = r[i];
        return v === null || v === undefined ? 0 : typeof v === "number" ? v.toLocaleString("en").length + 1 : v.length;
      }),
    );
    const width = Math.min(max, Math.max(longest, Math.min(h.length, 18)) + 2);
    ws.getColumn(i + 1).width = width;
    headerLines = Math.max(headerLines, Math.ceil(h.length / (width - 2)));
  });
  return headerLines;
}

function styleHeader(row: ExcelJS.Row, lines: number) {
  row.font = { bold: true };
  row.alignment = { vertical: "top", wrapText: true };
  row.height = Math.max(15, 15 * lines);
  row.eachCell((c) => {
    c.fill = solid(FILL_HEADER);
    c.border = { bottom: { style: "thin", color: { argb: "FFBFB8AD" } } };
  });
}

export type ExogenaXlsxInput = {
  report: ExogenaReport;
  formato: FormatoExogena;
  year: number;
  uvtPesos: number;
  /** Comercio que reporta (razón social y NIT tal como están guardados). */
  informante: { name: string; taxId: string | null };
  /** Traductor del namespace `opExogena`. */
  t: Tr;
  locale: Locale;
  /** Sólo para tests deterministas. */
  now?: Date;
};

export type ExogenaXlsx = { filename: string; body: Buffer; sheet: FormatoSheet };

/** Nombre del Excel: el del XML oficial (Dmuisca_…) con extensión .xlsx. */
export function xlsxFileName(formato: FormatoExogena, year: number): string {
  return dianFileName(formato, versionFormato(formato, year), year).replace(/\.xml$/, ".xlsx");
}

export async function buildFormatoXlsx(input: ExogenaXlsxInput): Promise<ExogenaXlsx> {
  const { report, formato, year, uvtPesos, informante, t, locale } = input;
  const sheet = buildFormatoSheet(report, formato, year, uvtPesos);
  const wb = new ExcelJS.Workbook();
  wb.creator = "MESAPAY";
  wb.created = input.now ?? new Date();

  /* ── Hoja de datos: lo que se pega en el prevalidador ── */
  const dataName = sheetName(t("xlsx.sheetData", { formato }));
  const ws = wb.addWorksheet(dataName, { views: [{ state: "frozen", ySplit: 1 }] });
  const headers = sheet.fields.map((f) => t(headerKey(formato, f)));
  // Texto vacío = celda vacía (el XML lo lleva como atributo vacío). Los
  // textos van como texto: en un .xlsx un texto que empieza por «=» no es
  // fórmula, y no se le antepone nada para no alterar el dato del XML.
  const cells = sheet.rows.map((r) => r.values.map((v) => (v === "" ? null : v)));
  ws.addRow(headers);
  cells.forEach((values, idx) => {
    const row = ws.addRow(values);
    const meta = sheet.rows[idx]!;
    values.forEach((v, j) => {
      const cell = row.getCell(j + 1);
      if (typeof v === "number") cell.numFmt = PLAIN_INT_FIELDS.has(sheet.fields[j]!) ? "0" : "#,##0";
      else cell.numFmt = "@";
    });
    if (meta.status !== "ok") {
      const fill = solid(meta.status === "omitted" ? FILL_OMITTED : FILL_WARNING);
      for (let j = 1; j <= headers.length; j++) row.getCell(j).fill = fill;
      const lines = [
        ...(meta.status === "omitted" ? [t("xlsx.rowOmitted")] : []),
        ...meta.issues.map((i) => t(`issue_${i.code}`)),
      ];
      row.getCell(1).note = lines.join("\n");
    }
  });
  styleHeader(ws.getRow(1), fitColumns(ws, headers, cells));
  if (headers.length > 0) {
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
  }

  /* ── Incidencias del formato (mismos textos que el panel) ── */
  if (sheet.issues.length > 0) {
    const wi = wb.addWorksheet(sheetName(t("xlsx.sheetIssues")), { views: [{ state: "frozen", ySplit: 1 }] });
    const ih = [
      t("xlsx.issueKind"),
      t("colTercero"),
      t("xlsx.issueText"),
      t("xlsx.issueAmount"),
      t("xlsx.issueRows", { sheet: dataName }),
    ];
    const irows = sheet.issues.map(({ issue, sheetRows }) => [
      issue.blocking ? t("issueBlocking") : t("issueWarning"),
      issue.name,
      t(`issue_${issue.code}`),
      pesos(issue.amountCents),
      sheetRows.length > 0 ? sheetRows.join(", ") : t("xlsx.issueNotInSheet"),
    ]);
    wi.addRow(ih);
    for (const [idx, r] of irows.entries()) {
      const row = wi.addRow(r);
      row.getCell(4).numFmt = "#,##0";
      if (sheet.issues[idx]!.issue.blocking) row.getCell(1).font = { bold: true, color: { argb: "FFB23A2E" } };
    }
    styleHeader(wi.getRow(1), fitColumns(wi, ih, irows, 60));
  }

  /* ── Información: metadatos fuera de la hoja de datos ── */
  const info = wb.addWorksheet(sheetName(t("xlsx.sheetInfo")));
  const status = !sheet.hasXml
    ? t("xlsx.statusNoXml")
    : sheet.blocked
      ? t("xlsx.statusBlocked")
      : t("xlsx.statusReady");
  /** [etiqueta, valor, formato numérico]: montos con miles, años y conteos sin. */
  const infoRows: [string, string | number, string?][] = [
    [t("xlsx.infoInformante"), informante.name],
    [t("xlsx.infoNit"), informante.taxId ?? ""],
    [t("yearLabel"), year, "0"],
    [t("xlsx.infoYearEnvio"), year + 1, "0"],
    [t("xlsx.infoFormato"), `${formato} · ${t(`f${formato}Name`)}`],
    [t("xlsx.infoVersion"), sheet.version, "0"],
    [t("statUvt"), uvtPesos, "#,##0"],
    [t("xlsx.infoStatus"), status],
  ];
  if (sheet.hasXml) {
    infoRows.push([t("xlsx.infoRecords"), sheet.xmlRecords, "0"]);
    const omitted = sheet.rows.length - sheet.xmlRecords;
    if (omitted > 0) infoRows.push([t("xlsx.infoOmitted"), omitted, "0"]);
  } else {
    infoRows.push([t("xlsx.infoRows"), sheet.rows.length, "0"]);
  }
  infoRows.push([t("xlsx.infoValorTotal"), sheet.valorTotal, "#,##0"]);
  if (sheet.hasXml) infoRows.push([t("xlsx.infoXmlFile"), dianFileName(formato, sheet.version, year)]);
  infoRows.push([t("xlsx.infoGenerated"), formatDate(input.now ?? new Date(), { locale })]);
  for (const [label, value, fmt] of infoRows) {
    const row = info.addRow([label, value]);
    row.getCell(1).font = { bold: true };
    const cell = row.getCell(2);
    cell.alignment = { horizontal: "left" };
    if (fmt) cell.numFmt = fmt;
  }
  info.addRow([]);
  const notes = [
    sheet.hasXml ? t("xlsx.notePaste", { sheet: dataName }) : t("xlsx.note2276"),
    ...(sheet.hasXml ? [t("xlsx.noteRules")] : []),
    ...(sheet.rows.some((r) => r.status === "omitted") ? [t("xlsx.noteBlocked")] : []),
    ...(sheet.rows.some((r) => r.status === "warning") ? [t("xlsx.noteWarnings")] : []),
  ];
  for (const n of notes) {
    const row = info.addRow([n]);
    info.mergeCells(row.number, 1, row.number, 2);
    row.getCell(1).alignment = { wrapText: true, vertical: "top" };
    row.height = 15 * Math.ceil(n.length / 95);
  }
  info.getColumn(1).width = 30;
  info.getColumn(2).width = 70;

  const out = await wb.xlsx.writeBuffer();
  return {
    filename: xlsxFileName(formato, year),
    body: Buffer.isBuffer(out) ? out : Buffer.from(out as ArrayBuffer),
    sheet,
  };
}
