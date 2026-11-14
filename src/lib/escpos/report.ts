/**
 * REPORTE térmico (hoy: el CIERRE DE TURNO): un documento de etiquetas y
 * montos por secciones, del dato ya resuelto a bytes ESC/POS.
 *
 * Mismo contrato que `prebill.ts` e `invoice.ts`: `renderReport` recibe un
 * documento con TODO resuelto —textos traducidos, montos formateados,
 * fechas escritas— y devuelve un Buffer. Sin DB, sin i18n, sin `Intl`.
 *
 * Y la misma idea de fondo: la vista imprimible del navegador
 * (`/operator/shifts/[id]/tirilla`, la de «Este dispositivo») dibuja ESTE
 * documento, no un armado propio. Lo que sale por la impresora de caja y
 * lo que sale por la impresora integrada del datáfono es el mismo papel.
 *
 * Genérico a propósito (secciones de filas etiqueta → valor): el próximo
 * reporte de caja que quiera salir en tirilla (un corte X, el arqueo de un
 * mesero) entra con el mismo sobre y el mismo render, sin migración (el
 * `kind` del PrintJob es un String libre).
 */

import {
  DEFAULT_LINE_SPACING,
  LF,
  align,
  bold,
  columnsForWidth,
  cut,
  feed,
  line,
  padRow,
  separator,
  wrap,
} from "./commands";
import {
  DETAIL_SEPARATOR,
  colsForSize,
  compactStart,
  totalRowChunks,
  withLineSpacingFor,
  type TextSize,
} from "./compact";

export type ThermalReportRow = {
  label: string;
  value: string;
  /** Negrita a doble alto, como el TOTAL de la factura. */
  strong?: boolean;
};

export type ThermalReportSection = {
  /** "VENTAS", "POR MÉTODO DE PAGO"… ya traducido. */
  title: string;
  rows: ThermalReportRow[];
  /** Texto corrido debajo de las filas (una nota, una aclaración). */
  notes: string[];
};

export type ThermalReport = {
  /** 80 o 58. Decide las columnas (48 vs 32). */
  paperWidthMm: number;
  businessName: string;
  /** NIT y lo que el comercio tenga cargado. */
  businessLines: string[];
  /** "CIERRE DE TURNO", ya traducido. Va grande. */
  title: string;
  /** Día de negocio, apertura, cierre, duración, de quién es el turno. */
  metaRows: ThermalReportRow[];
  sections: ThermalReportSection[];
  footerLines: string[];
};

/** Versión del sobre que se guarda en PrintJob.payload. */
export const REPORT_PAYLOAD_VERSION = 1;

export type ReportPrintJobPayload = {
  v: typeof REPORT_PAYLOAD_VERSION;
  report: ThermalReport;
};

/** `kind` del PrintJob del cierre de turno. */
export const SHIFT_CLOSE_JOB_KIND = "shift_close";

function stringList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string") : [];
}

function rowList(raw: unknown): ThermalReportRow[] {
  if (!Array.isArray(raw)) return [];
  const out: ThermalReportRow[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const row = r as Record<string, unknown>;
    if (typeof row.label !== "string" || typeof row.value !== "string") continue;
    out.push({
      label: row.label,
      value: row.value,
      ...(row.strong === true ? { strong: true } : {}),
    });
  }
  return out;
}

/**
 * Valida (sin confiar) un payload leído de la DB. null si no tiene la
 * forma esperada: un trabajo corrupto se cierra en fallido en vez de
 * trabar la cola.
 */
export function parseReportPayload(raw: unknown): ThermalReport | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const env = raw as Record<string, unknown>;
  if (env.v !== REPORT_PAYLOAD_VERSION) return null;
  const r = env.report;
  if (!r || typeof r !== "object" || Array.isArray(r)) return null;
  const doc = r as Record<string, unknown>;
  if (typeof doc.paperWidthMm !== "number") return null;
  if (typeof doc.businessName !== "string") return null;
  if (typeof doc.title !== "string") return null;
  if (!Array.isArray(doc.sections)) return null;
  const sections: ThermalReportSection[] = [];
  for (const s of doc.sections) {
    if (!s || typeof s !== "object") return null;
    const sec = s as Record<string, unknown>;
    if (typeof sec.title !== "string") return null;
    sections.push({ title: sec.title, rows: rowList(sec.rows), notes: stringList(sec.notes) });
  }
  return {
    paperWidthMm: doc.paperWidthMm,
    businessName: doc.businessName,
    businessLines: stringList(doc.businessLines),
    title: doc.title,
    metaRows: rowList(doc.metaRows),
    sections,
    footerLines: stringList(doc.footerLines),
  };
}

/** El título: doble ANCHO, alto normal, como "PRECUENTA". */
const TITLE_SIZE: TextSize = { width: 2, height: 1 };

/**
 * Bytes ESC/POS completos del reporte, listos para el socket TCP:9100. El
 * agente NO interpreta nada. Formato compacto, como la factura y la
 * precuenta: etiqueta a la izquierda, monto pegado a la derecha.
 */
export function renderReport(doc: ThermalReport): Buffer {
  const cols = columnsForWidth(doc.paperWidthMm);
  const chunks: Buffer[] = [];

  chunks.push(...compactStart());

  // ── Identidad del comercio ──────────────────────────────────────────
  chunks.push(align("center"), bold(true));
  for (const l of wrap(doc.businessName, cols)) chunks.push(line(l));
  chunks.push(bold(false));
  if (doc.businessLines.length > 0) {
    for (const l of wrap(doc.businessLines.join(DETAIL_SEPARATOR), cols)) chunks.push(line(l));
  }

  // ── Título ──────────────────────────────────────────────────────────
  chunks.push(separator(cols));
  chunks.push(
    bold(true),
    ...withLineSpacingFor(TITLE_SIZE, wrap(doc.title, colsForSize(cols, TITLE_SIZE)).map(line)),
    bold(false),
  );

  // ── Datos del turno ─────────────────────────────────────────────────
  chunks.push(align("left"));
  for (const row of doc.metaRows) {
    for (const l of padRow(row.label, row.value, cols)) chunks.push(line(l));
  }

  // ── Secciones ───────────────────────────────────────────────────────
  for (const section of doc.sections) {
    chunks.push(separator(cols), bold(true));
    for (const l of wrap(section.title, cols)) chunks.push(line(l));
    chunks.push(bold(false));
    for (const row of section.rows) {
      chunks.push(...totalRowChunks({ label: row.label, amount: row.value, strong: row.strong }, cols));
    }
    for (const note of section.notes) {
      for (const l of wrap(note, cols)) chunks.push(line(l));
    }
  }

  // ── Pie ─────────────────────────────────────────────────────────────
  chunks.push(DEFAULT_LINE_SPACING);
  if (doc.footerLines.length > 0) {
    chunks.push(separator(cols), align("center"));
    for (const l of doc.footerLines) {
      for (const w of wrap(l, cols)) chunks.push(line(w));
    }
  }

  // ── Cierre: alimentar y corte parcial, como los demás papeles ──────
  chunks.push(align("left"), feed(4), cut(), LF);
  return Buffer.concat(chunks);
}
