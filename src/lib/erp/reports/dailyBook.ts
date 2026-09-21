/**
 * Libro diario (lógica pura). Portado de zenith `reportes/libro-diario`.
 *
 * Dos modos (D. 2649/93 art. 125: registro individual o por resúmenes):
 *  · `detallado`: comprobante por comprobante, con sus líneas;
 *  · `resumido`: agrupa por día × cuenta (Σ débitos y créditos).
 *
 * Los asientos anulados (status ≠ posted) se INCLUYEN marcados, como en
 * zenith: el libro es cronológico y no se le quitan folios. Sí se
 * cuentan en los totales (un anulado también cuadra).
 */
import { compareMovements, formatVoucherNumber } from "./generalLedger";

export type DailyBookLineInput = {
  accountCode: string;
  accountName: string;
  debitCents: number;
  creditCents: number;
  memo?: string | null;
};

export type DailyBookEntryInput = {
  id: string;
  date: Date | string;
  voucherNumber: number | null;
  source: string;
  memo: string | null;
  status: string;
  createdAt: Date | string;
  lines: DailyBookLineInput[];
};

export type DailyBookMode = "detallado" | "resumido";

export type DailyBookEntry = {
  id: string;
  date: string;
  voucherNumber: number | null;
  source: string;
  memo: string | null;
  status: string;
  voided: boolean;
  debitCents: number;
  creditCents: number;
  lines: DailyBookLineInput[];
};

export type DailyBookDayRow = {
  accountCode: string;
  accountName: string;
  debitCents: number;
  creditCents: number;
};

export type DailyBookDay = {
  /** `yyyy-mm-dd` (UTC, como los límites del reporte). */
  date: string;
  rows: DailyBookDayRow[];
  debitCents: number;
  creditCents: number;
};

export type DailyBookStats = {
  entries: number;
  voided: number;
  debitCents: number;
  creditCents: number;
  /** Partida doble: Σ débitos = Σ créditos (±1 centavo). */
  balanced: boolean;
};

export type DailyBook =
  | { mode: "detallado"; entries: DailyBookEntry[]; stats: DailyBookStats }
  | { mode: "resumido"; days: DailyBookDay[]; stats: DailyBookStats };

export const DAILY_BOOK_MODES: readonly DailyBookMode[] = ["detallado", "resumido"];

export function parseDailyBookMode(raw: string | undefined | null): DailyBookMode {
  return raw === "resumido" ? "resumido" : "detallado";
}

export function isVoided(status: string): boolean {
  return status !== "posted";
}

function toDate(d: Date | string): Date {
  return d instanceof Date ? d : new Date(d);
}

function sortEntries(entries: readonly DailyBookEntryInput[]) {
  return entries
    .map((e) => ({ e, date: toDate(e.date), createdAt: toDate(e.createdAt) }))
    .sort((a, b) =>
      compareMovements(
        { date: a.date, voucherNumber: a.e.voucherNumber, createdAt: a.createdAt },
        { date: b.date, voucherNumber: b.e.voucherNumber, createdAt: b.createdAt },
      ),
    );
}

export function buildDailyBook(
  entries: readonly DailyBookEntryInput[],
  { mode }: { mode: DailyBookMode },
): DailyBook {
  const sorted = sortEntries(entries);
  let debit = 0;
  let credit = 0;
  let voided = 0;
  const detailed: DailyBookEntry[] = sorted.map(({ e, date }) => {
    const d = e.lines.reduce((s, l) => s + l.debitCents, 0);
    const c = e.lines.reduce((s, l) => s + l.creditCents, 0);
    debit += d;
    credit += c;
    const isVoid = isVoided(e.status);
    if (isVoid) voided++;
    return {
      id: e.id,
      date: date.toISOString(),
      voucherNumber: e.voucherNumber,
      source: e.source,
      memo: e.memo,
      status: e.status,
      voided: isVoid,
      debitCents: d,
      creditCents: c,
      // Débitos primero y luego por código, como se lee un comprobante.
      lines: [...e.lines].sort(
        (a, b) =>
          Number(b.debitCents > 0) - Number(a.debitCents > 0) ||
          a.accountCode.localeCompare(b.accountCode),
      ),
    };
  });
  const stats: DailyBookStats = {
    entries: detailed.length,
    voided,
    debitCents: debit,
    creditCents: credit,
    balanced: Math.abs(debit - credit) <= 1,
  };
  if (mode === "detallado") return { mode, entries: detailed, stats };

  // Resumido: día × cuenta. Un Map anidado conserva el orden cronológico
  // de los días (ya vienen ordenados) y el código ordena las cuentas.
  const days = new Map<string, Map<string, DailyBookDayRow>>();
  for (const e of detailed) {
    const day = e.date.slice(0, 10);
    let bucket = days.get(day);
    if (!bucket) {
      bucket = new Map();
      days.set(day, bucket);
    }
    for (const l of e.lines) {
      let row = bucket.get(l.accountCode);
      if (!row) {
        row = { accountCode: l.accountCode, accountName: l.accountName, debitCents: 0, creditCents: 0 };
        bucket.set(l.accountCode, row);
      }
      row.debitCents += l.debitCents;
      row.creditCents += l.creditCents;
    }
  }
  const summarized: DailyBookDay[] = [...days.entries()].map(([date, bucket]) => {
    const rows = [...bucket.values()].sort((a, b) => a.accountCode.localeCompare(b.accountCode));
    return {
      date,
      rows,
      debitCents: rows.reduce((s, r) => s + r.debitCents, 0),
      creditCents: rows.reduce((s, r) => s + r.creditCents, 0),
    };
  });
  return { mode, days: summarized, stats };
}

/**
 * Filas del CSV. Detallado: Fecha, Comprobante, Origen, Descripción,
 * Cuenta, Nombre cuenta, Débito, Crédito. Resumido: Fecha, Cuenta, Nombre,
 * Débitos, Créditos.
 */
export function dailyBookCsvRows(
  book: DailyBook,
  labels: { unnumbered: string; voided: string; sourceLabel: (source: string) => string },
): (string | number)[][] {
  if (book.mode === "resumido") {
    return book.days.flatMap((d) =>
      d.rows.map((r) => [d.date, r.accountCode, r.accountName, r.debitCents, r.creditCents]),
    );
  }
  return book.entries.flatMap((e) =>
    e.lines.map((l) => [
      e.date.slice(0, 10),
      formatVoucherNumber(e.voucherNumber) ?? labels.unnumbered,
      labels.sourceLabel(e.source),
      [e.voided ? labels.voided : null, l.memo ?? e.memo].filter(Boolean).join(" · "),
      l.accountCode,
      l.accountName,
      l.debitCents,
      l.creditCents,
    ]),
  );
}
