// Importador del plan de cuentas propio del comercio.
//
// El contador entrega su PUC en una hoja de cálculo; acá se parsea el CSV
// pegado y se normaliza a la forma de LedgerAccount. Es ADITIVO por diseño:
// nunca borra ni desactiva cuentas del catálogo base, porque el motor de
// asientos (src/lib/erp/posting.ts) escribe contra códigos fijos.

import { pucLevel, pucParentCode, type PucNature, type PucType } from "./pucNiif";

export type ParsedAccount = {
  code: string;
  name: string;
  type: PucType;
  nature: PucNature;
  level: number;
  parentCode: string | null;
  postable: boolean;
  /** true = no venía en el archivo; se generó para no dejar hijas huérfanas. */
  synthesized: boolean;
};

export type ChartIssueReason =
  | "not_numeric"
  | "bad_length"
  | "bad_class"
  | "duplicate"
  | "no_name";

export type ChartImportIssue = {
  /** Línea del archivo (1-based) para que el contador la ubique. */
  line: number;
  /** Lo que venía en la primera celda (recortado para no romper el layout). */
  code: string;
  reason: ChartIssueReason;
};

export type ParsedChart = {
  rows: ParsedAccount[];
  issues: ChartImportIssue[];
};

/** Clase PUC (primer dígito) → tipo de cuenta. 7/8/9 no se soportan. */
const CLASS_TYPE: Record<string, PucType> = {
  "1": "activo",
  "2": "pasivo",
  "3": "patrimonio",
  "4": "ingreso",
  "5": "gasto",
  "6": "costo",
};

/** Naturaleza por defecto cuando el archivo no la trae. */
function defaultNature(type: PucType): PucNature {
  return type === "activo" || type === "gasto" || type === "costo"
    ? "debito"
    : "credito";
}

/** Longitudes válidas: clase, grupo, cuenta, subcuenta, auxiliar. */
const VALID_LENGTHS = new Set([1, 2, 4, 6, 8]);

/**
 * Parte una línea CSV respetando comillas — los nombres de cuenta traen comas
 * ("Propiedad, Planta y Equipo"), así que un split pelado las rompe.
 */
function splitCells(line: string, sep: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === sep) {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

/** Separador del archivo: `;` y tab ganan porque los nombres traen comas. */
function detectSeparator(lines: string[]): string {
  const sample = lines.slice(0, 5).join("\n");
  if (sample.includes(";")) return ";";
  if (sample.includes("\t")) return "\t";
  return ",";
}

function parseNature(raw: string, type: PucType): PucNature {
  const v = raw
    .toUpperCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  if (v.startsWith("D")) return "debito";
  if (v.startsWith("C")) return "credito";
  return defaultNature(type);
}

const TRUTHY = new Set(["TRUE", "SI", "S", "X", "1", "YES", "Y", "VERDADERO"]);

function parsePostable(raw: string): boolean {
  return TRUTHY.has(
    raw
      .toUpperCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .trim(),
  );
}

/**
 * Parsea el CSV del contador: `código;nombre;naturaleza;acepta movimiento`.
 * Las columnas extra (maneja terceros, centro de costo, observaciones) se
 * ignoran — MESAPAY todavía no las modela.
 *
 * Devuelve las cuentas normalizadas MÁS las agrupadoras que faltaban para que
 * el árbol cierre (marcadas `synthesized`), y la lista de líneas descartadas
 * con su motivo para que el contador las corrija.
 */
export function parseChartCsv(text: string): ParsedChart {
  const rawLines = text.split(/\r?\n/);
  const sep = detectSeparator(rawLines.filter((l) => l.trim() !== ""));

  const rows: ParsedAccount[] = [];
  const issues: ChartImportIssue[] = [];
  const byCode = new Map<string, ParsedAccount>();
  let seenFirstData = false;

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i]!;
    if (line.trim() === "") continue;
    const cells = splitCells(line, sep);
    const raw = (cells[0] ?? "").trim();
    const code = raw.replace(/\s/g, "");
    const name = (cells[1] ?? "").trim();

    if (!/^\d+$/.test(code)) {
      // Encabezado: sólo se salta en silencio si es la primera fila con datos.
      if (!seenFirstData) {
        seenFirstData = true;
        continue;
      }
      issues.push({ line: i + 1, code: raw.slice(0, 40), reason: "not_numeric" });
      continue;
    }
    seenFirstData = true;

    if (!VALID_LENGTHS.has(code.length)) {
      issues.push({ line: i + 1, code, reason: "bad_length" });
      continue;
    }
    const type = CLASS_TYPE[code[0]!];
    if (!type) {
      issues.push({ line: i + 1, code, reason: "bad_class" });
      continue;
    }
    if (name === "") {
      issues.push({ line: i + 1, code, reason: "no_name" });
      continue;
    }
    if (byCode.has(code)) {
      issues.push({ line: i + 1, code, reason: "duplicate" });
      continue;
    }

    const row: ParsedAccount = {
      code,
      name: name.slice(0, 120),
      type,
      nature: parseNature(cells[2] ?? "", type),
      level: pucLevel(code),
      parentCode: pucParentCode(code),
      postable: parsePostable(cells[3] ?? ""),
      synthesized: false,
    };
    byCode.set(code, row);
    rows.push(row);
  }

  // Agrupadoras faltantes: si el archivo trae 11050501 pero no 110505, el
  // árbol quedaría colgando. Se crean como no imputables, tomando el nombre
  // de la primera hija que las necesita (el contador puede renombrarlas).
  for (const row of [...rows]) {
    let parent = row.parentCode;
    let heir = row;
    while (parent) {
      if (!byCode.has(parent)) {
        const type = CLASS_TYPE[parent[0]!];
        if (!type) break;
        const synth: ParsedAccount = {
          code: parent,
          name: heir.name,
          type,
          nature: defaultNature(type),
          level: pucLevel(parent),
          parentCode: pucParentCode(parent),
          postable: false,
          synthesized: true,
        };
        byCode.set(parent, synth);
        rows.push(synth);
        heir = synth;
      } else {
        heir = byCode.get(parent)!;
      }
      parent = pucParentCode(parent);
    }
  }

  rows.sort((a, b) => a.code.localeCompare(b.code));
  return { rows, issues };
}
