// Extracto bancario pegado (conciliación) — lógica PURA, sin DB.
//
// Antes el parser vivía en la ruta y tomaba como monto la ÚLTIMA celda
// numérica de la fila: en los extractos colombianos esa suele ser el SALDO
// (Bancolombia: Fecha;Descripción;…;Valor;Saldo), y con débito y crédito en
// columnas separadas todo entraba como entrada. Ahora, si el pegado trae la
// fila de títulos, las columnas se leen por nombre: valor/monto, o débito y
// crédito por separado, y el saldo se ignora. Sin títulos se mantiene la
// lectura de siempre (fecha + última celda numérica).
//
// También acá: la llave con la que una línea ya importada no se vuelve a
// importar si se pega el mismo extracto dos veces.

export type ParsedBankLine = { date: Date; description: string; amountCents: number };

export type ParsedBankStatement = {
  lines: ParsedBankLine[];
  /** Filas que no se pudieron leer (sin fecha o sin monto). */
  skipped: number;
  /** true = se reconoció la fila de títulos y se leyó por columnas. */
  byHeader: boolean;
};

/** Texto sin tildes, en minúsculas y sin espacios repetidos. */
export function foldText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitRow(rawLine: string): string[] {
  const sep = rawLine.includes(";") ? ";" : rawLine.includes("\t") ? "\t" : ",";
  return rawLine.split(sep).map((c) => c.trim().replace(/^"|"$/g, ""));
}

/** dd/mm/yyyy, d/m/yyyy o yyyy-mm-dd → medianoche UTC del día. */
function parseDateCell(c: string): Date | null {
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(c);
  if (m) return validDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(c);
  if (m) return validDate(Number(m[3]), Number(m[2]), Number(m[1]));
  return null;
}

function validDate(y: number, mo: number, d: number): Date | null {
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? date : null;
}

/**
 * Monto de una celda: "1.234.567,89" / "1,234,567.89" / "$ 500" / "(500)" /
 * "-500". La última puntuación es el separador decimal si deja 1-2 dígitos.
 * null si la celda no es un monto.
 */
export function parseAmountCell(raw: string): number | null {
  let c = raw.trim();
  if (c === "") return null;
  let negative = false;
  if (/^\(.*\)$/.test(c)) {
    negative = true;
    c = c.slice(1, -1);
  }
  if (c.startsWith("-")) {
    negative = true;
    c = c.slice(1);
  }
  if (!/^[\d.,$\s]+$/.test(c) || !/\d/.test(c)) return null;
  c = c.replace(/[$\s]/g, "");
  const lastSep = Math.max(c.lastIndexOf(","), c.lastIndexOf("."));
  let pesos: number;
  if (lastSep > -1 && c.length - lastSep - 1 <= 2) {
    const intPart = c.slice(0, lastSep).replace(/[.,]/g, "");
    const decPart = c.slice(lastSep + 1);
    pesos = Number(`${intPart}.${decPart}`);
  } else {
    pesos = Number(c.replace(/[.,]/g, ""));
  }
  if (!isFinite(pesos)) return null;
  return Math.round(pesos * 100) * (negative ? -1 : 1);
}

type Columns = {
  date: number;
  amount: number;
  debit: number;
  credit: number;
  balance: number;
};

const ALIASES: Record<keyof Columns, string[]> = {
  date: ["fecha", "date", "fecha movimiento", "fecha de movimiento", "fecha transaccion", "fecha de transaccion"],
  amount: ["valor", "monto", "importe", "amount", "valor transaccion", "valor del movimiento"],
  debit: ["debito", "debitos", "cargo", "cargos", "retiro", "retiros", "egreso", "egresos", "salida", "salidas", "debit"],
  credit: ["credito", "creditos", "abono", "abonos", "deposito", "depositos", "ingreso", "ingresos", "entrada", "entradas", "credit"],
  balance: ["saldo", "saldos", "balance", "saldo disponible", "saldo total", "saldo final"],
};

/** Columnas por nombre si la fila es de títulos; null si no lo parece. */
function headerColumns(cells: string[]): Columns | null {
  if (cells.slice(0, 3).some((c) => parseDateCell(c))) return null;
  const folded = cells.map(foldText);
  const find = (key: keyof Columns) => folded.findIndex((h) => ALIASES[key].includes(h));
  const cols: Columns = {
    date: find("date"),
    amount: find("amount"),
    debit: find("debit"),
    credit: find("credit"),
    balance: find("balance"),
  };
  const hasAmount = cols.amount >= 0 || cols.debit >= 0 || cols.credit >= 0;
  return hasAmount ? cols : null;
}

function describe(cells: string[], used: ReadonlySet<number>): string {
  return (
    cells
      .filter((_, i) => !used.has(i))
      .filter(Boolean)
      .join(" · ")
      .slice(0, 300) || "—"
  );
}

/** Lectura de siempre (sin títulos): fecha en las 3 primeras celdas y la última celda numérica. */
function parseLegacyRow(cells: string[]): ParsedBankLine | null {
  if (cells.length < 2) return null;
  let date: Date | null = null;
  let dateIdx = -1;
  for (let i = 0; i < cells.length && i < 3; i++) {
    const d = parseDateCell(cells[i]!);
    if (d) {
      date = d;
      dateIdx = i;
      break;
    }
  }
  if (!date) return null;
  for (let i = cells.length - 1; i >= 0; i--) {
    if (i === dateIdx) continue;
    const amountCents = parseAmountCell(cells[i]!);
    if (amountCents == null) continue;
    if (amountCents === 0) return null;
    return { date, description: describe(cells, new Set([dateIdx, i])), amountCents };
  }
  return null;
}

function parseHeaderRow(cells: string[], cols: Columns): ParsedBankLine | null {
  let date: Date | null = null;
  let dateIdx = cols.date;
  if (dateIdx >= 0) date = parseDateCell(cells[dateIdx] ?? "");
  if (!date) {
    for (let i = 0; i < cells.length && i < 3; i++) {
      const d = parseDateCell(cells[i]!);
      if (d) {
        date = d;
        dateIdx = i;
        break;
      }
    }
  }
  if (!date) return null;
  let amountCents: number | null = null;
  if (cols.amount >= 0) {
    amountCents = parseAmountCell(cells[cols.amount] ?? "");
  } else {
    // Débito (sale plata) y crédito (entra) en columnas separadas; el banco
    // los pone en positivo, la columna dice el sentido.
    const debit = cols.debit >= 0 ? parseAmountCell(cells[cols.debit] ?? "") : null;
    const credit = cols.credit >= 0 ? parseAmountCell(cells[cols.credit] ?? "") : null;
    if (debit != null || credit != null) {
      amountCents = Math.abs(credit ?? 0) - Math.abs(debit ?? 0);
    }
  }
  if (amountCents == null || amountCents === 0) return null;
  const used = new Set([dateIdx, cols.amount, cols.debit, cols.credit, cols.balance].filter((i) => i >= 0));
  return { date, description: describe(cells, used), amountCents };
}

/**
 * Lee el extracto pegado. La primera fila con datos puede ser la de títulos:
 * si nombra el valor (o débito/crédito) se lee por columnas; si no, se
 * descarta como encabezado y se usa la lectura de siempre.
 */
export function parseBankStatement(csv: string): ParsedBankStatement {
  const rows = csv.split(/\r?\n/).filter((l) => l.trim() !== "");
  const lines: ParsedBankLine[] = [];
  let skipped = 0;
  let cols: Columns | null = null;
  let first = true;
  for (const row of rows) {
    const cells = splitRow(row);
    if (first) {
      first = false;
      const header = headerColumns(cells);
      if (header) {
        cols = header;
        continue;
      }
    }
    const parsed = cols ? parseHeaderRow(cells, cols) : parseLegacyRow(cells);
    if (parsed) lines.push(parsed);
    else skipped++;
  }
  return { lines, skipped, byHeader: cols != null };
}

/** Llave de una línea del extracto: día, monto y descripción normalizada. */
export function bankLineKey(l: { date: Date; amountCents: number; description: string }): string {
  return `${l.date.toISOString().slice(0, 10)}|${l.amountCents}|${foldText(l.description)}`;
}

/**
 * Lo nuevo de un pegado frente a lo ya importado: por cada llave entran sólo
 * las que superan las que ya había. Pegar el mismo extracto dos veces no
 * duplica nada, y dos movimientos iguales del mismo día en el primer pegado
 * siguen entrando los dos.
 */
export function dedupeBankLines<T extends ParsedBankLine>(
  incoming: readonly T[],
  existing: readonly { date: Date; amountCents: number; description: string }[],
): { fresh: T[]; duplicates: number } {
  const left = new Map<string, number>();
  for (const e of existing) left.set(bankLineKey(e), (left.get(bankLineKey(e)) ?? 0) + 1);
  const fresh: T[] = [];
  let duplicates = 0;
  for (const l of incoming) {
    const k = bankLineKey(l);
    const n = left.get(k) ?? 0;
    if (n > 0) {
      left.set(k, n - 1);
      duplicates++;
    } else {
      fresh.push(l);
    }
  }
  return { fresh, duplicates };
}
