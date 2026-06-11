/**
 * Minimal CSV parser for the CRM import route.
 *
 * Features:
 * - Delimiter auto-detection: comma vs semicolon (checks first line).
 * - Basic quoted field handling (double-quoted fields, "" escape).
 * - Whitespace trimming of field values (but not inside quotes).
 * - Returns rows as string arrays; first row is treated as headers.
 */

/** Split a single CSV line, respecting double-quoted fields. */
export function splitCsvLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (inQuotes) {
      if (ch === '"') {
        // Peek ahead: "" inside quotes = escaped quote.
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++; // skip the second "
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === delimiter) {
        fields.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
  }
  fields.push(current.trim());
  return fields;
}

/** Sniff the delimiter from the first line. */
export function sniffDelimiter(firstLine: string): string {
  const commaCount = (firstLine.match(/,/g) ?? []).length;
  const semicolonCount = (firstLine.match(/;/g) ?? []).length;
  return semicolonCount > commaCount ? ";" : ",";
}

export interface ParsedCsvResult {
  /** Headers from the first row (normalized: lowercase, trimmed). */
  headers: string[];
  /** Remaining rows as objects keyed by header. */
  rows: Record<string, string>[];
}

/**
 * Parse a CSV string.
 *
 * - Skips blank lines.
 * - Tolerates missing columns (missing fields default to "").
 * - Max 502 lines read (1 header + 501 data rows — callers cap at 500).
 */
export function parseCsv(csv: string): ParsedCsvResult {
  const lines = csv.split(/\r?\n/);
  const nonEmpty = lines.filter((l) => l.trim().length > 0);

  if (nonEmpty.length === 0) return { headers: [], rows: [] };

  const delimiter = sniffDelimiter(nonEmpty[0]);
  const rawHeaders = splitCsvLine(nonEmpty[0], delimiter);
  const headers = rawHeaders.map((h) => h.toLowerCase().trim());

  const rows: Record<string, string>[] = [];
  const dataLines = nonEmpty.slice(1, 502); // max 501 data lines read

  for (const line of dataLines) {
    const fields = splitCsvLine(line, delimiter);
    const row: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) {
      row[headers[i]] = fields[i] ?? "";
    }
    rows.push(row);
  }

  return { headers, rows };
}
