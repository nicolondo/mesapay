// CSV de reportes contables — dialecto "Siigo/Excel en español", el mismo
// que usa zenith en sus reportes (§ Comprobantes detallados):
//   - separador `;` (Excel en es-CO/es-MX abre con punto y coma sin asistente);
//   - decimales con COMA y sin separador de miles (centavos → unidades con
//     2 decimales: 1234567 → "12345,67");
//   - BOM UTF-8 al inicio (Excel muestra bien los acentos);
//   - filas terminadas en CRLF;
//   - celdas de texto entre comillas sólo cuando hace falta (`;`, `"`, salto
//     de línea), con `"` duplicada;
//   - celdas de texto que empiezan por `= + - @` (o tab/CR) van prefijadas
//     con `'` para que una hoja de cálculo NO las ejecute como fórmula
//     (inyección CSV). Los montos son números y no pasan por esa regla.
//
// Distinto de `toCsv` (accounting.ts), que es RFC 4180 con coma y punto
// decimal: ese es para los libros genéricos importables a Siigo/Alegra/
// Contpaqi; este es para lo que el contador abre directo en Excel.

export type CsvCell = string | number | null | undefined;

const DANGEROUS = /^[=+\-@\t\r]/;

/** Centavos → "12345,67" (coma decimal, sin miles). */
export function csvAmount(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${sign}${whole},${frac}`;
}

function textCell(raw: string): string {
  let v = raw.replace(/\r?\n/g, " ");
  if (DANGEROUS.test(v)) v = `'${v}`;
  if (/[;"]/.test(v)) v = `"${v.replace(/"/g, '""')}"`;
  return v;
}

function cell(v: CsvCell): string {
  if (v == null) return "";
  if (typeof v === "number") return csvAmount(v);
  return textCell(v);
}

/**
 * Arma el CSV completo. `note` (opcional) va como primera línea, antes de
 * los encabezados — para reportes que quieren razón social / período arriba.
 * Los números de `rows` se interpretan como CENTAVOS.
 */
export function buildReportCsv(args: {
  headers: string[];
  rows: CsvCell[][];
  note?: string;
}): string {
  const lines: string[] = [];
  if (args.note) lines.push(textCell(args.note));
  lines.push(args.headers.map(textCell).join(";"));
  for (const r of args.rows) lines.push(r.map(cell).join(";"));
  return "﻿" + lines.join("\r\n") + "\r\n";
}
