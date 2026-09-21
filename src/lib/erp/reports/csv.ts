/**
 * CSV de los reportes contables — dialecto portado de zenith
 * (`libro-diario/libro-buttons.tsx` + `movimiento-auxiliar/csv.ts`):
 *
 *  · separador `;` y decimales con COMA (así lo abre Excel es-CO sin
 *    asistente de importación);
 *  · BOM UTF-8 al frente para que Excel respete los acentos;
 *  · montos en unidades de moneda con 2 decimales (`centsToCsv`);
 *  · protección contra inyección: una celda de texto que empiece por
 *    `= + - @ \t \r` la hoja de cálculo la ejecuta como FÓRMULA, así que
 *    se le antepone un apóstrofo;
 *  · `note` opcional como PRIMERA fila (antes de los encabezados), para
 *    avisos que no pueden perderse («totales del filtro aplicado»…).
 *
 * Es distinto del `toCsv` de `accounting.ts` (coma y punto decimal, para
 * importar a Siigo/Alegra): estos CSV son para que el contador cuadre en
 * Excel, no para migrar datos.
 */

/**
 * Celda del CSV. Un `number` se interpreta SIEMPRE como CENTAVOS y sale
 * como monto con dos decimales; lo que no sea plata (números de
 * comprobante, códigos) viaja como string.
 */
export type CsvValue = string | number | null | undefined;

export const CSV_BOM = "\uFEFF";
export const CSV_SEPARATOR = ";";
export const CSV_CONTENT_TYPE = "text/csv; charset=utf-8";

/** Centavos → "1234,56" (coma decimal, sin miles). */
export function centsToCsv(cents: number): string {
  return (cents / 100).toFixed(2).replace(".", ",");
}

const FORMULA_START = /^[=+\-@\t\r]/;

/** Texto escapado: guardia de inyección + comillas si hace falta. */
export function csvText(raw: string): string {
  const v = FORMULA_START.test(raw) ? `'${raw}` : raw;
  return v.includes(CSV_SEPARATOR) || v.includes('"') || v.includes("\n") || v.includes("\r")
    ? `"${v.replaceAll('"', '""')}"`
    : v;
}

export function csvCell(v: CsvValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return centsToCsv(v);
  return csvText(v);
}

export function csvRow(values: CsvValue[]): string {
  return values.map(csvCell).join(CSV_SEPARATOR);
}

/** El archivo completo, con BOM. Las líneas van con CRLF (RFC 4180). */
export function buildReportCsv({
  headers,
  rows,
  note,
}: {
  headers: string[];
  rows: CsvValue[][];
  note?: string | null;
}): string {
  const lines = [
    ...(note ? [csvText(note)] : []),
    csvRow(headers),
    ...rows.map(csvRow),
  ];
  return CSV_BOM + lines.join("\r\n");
}

/** Respuesta HTTP de descarga. El nombre se limpia de comillas y saltos. */
export function csvResponse(filename: string, csv: string): Response {
  const safe = filename.replace(/["\r\n]/g, "_");
  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": CSV_CONTENT_TYPE,
      "Content-Disposition": `attachment; filename="${safe}"`,
      "Cache-Control": "no-store",
    },
  });
}
