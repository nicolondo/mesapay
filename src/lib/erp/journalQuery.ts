// Libro de comprobantes: filtros de URL + paginación por cursor (keyset).
//
// Orden del libro: fecha desc → número de comprobante desc (los sin numerar
// al final del día) → creación desc → id desc. El cursor codifica esa tupla
// y el `where` de la página siguiente la reproduce en SQL, así que cada
// tanda recorre EXACTAMENTE el mismo conjunto filtrado (patrón de zenith:
// búsqueda server-side sobre todo el libro, no sobre lo ya cargado).
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getAccountingConfig, isMonthClosed } from "./cierre";
import { canMutateManual, canReverse, monthOf } from "./journalManual";

export const ENTRIES_PAGE_SIZE = 50;
export const ENTRIES_PAGE_MAX = 200;

export type EntriesParams = {
  desde?: string | null;
  hasta?: string | null;
  q?: string | null;
};

export type EntriesCursor = {
  date: string;
  voucherNumber: number | null;
  createdAt: string;
  id: string;
};

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/** "YYYY-MM-DD" → inicio del día (UTC); null si no es una fecha válida. */
export function parseYmd(v: string | null | undefined): Date | null {
  if (!v || !YMD_RE.test(v)) return null;
  const d = new Date(`${v}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Filtro base del libro (fechas inclusivas + búsqueda por número o texto). */
export function buildEntriesWhere(
  restaurantId: string,
  params: EntriesParams,
): Prisma.JournalEntryWhereInput {
  const where: Prisma.JournalEntryWhereInput = { restaurantId };
  const from = parseYmd(params.desde);
  const to = parseYmd(params.hasta);
  if (from || to) {
    where.date = {
      ...(from && { gte: from }),
      // `hasta` inclusivo: hasta el último instante del día.
      ...(to && { lt: new Date(to.getTime() + 86_400_000) }),
    };
  }
  const q = (params.q ?? "").trim();
  if (q) {
    if (/^#?\d{1,9}$/.test(q)) {
      where.voucherNumber = Number(q.replace("#", ""));
    } else {
      where.memo = { contains: q, mode: "insensitive" };
    }
  }
  return where;
}

/** Condición "después del cursor" en el orden del libro. */
export function buildCursorWhere(c: EntriesCursor): Prisma.JournalEntryWhereInput {
  const date = new Date(c.date);
  const createdAt = new Date(c.createdAt);
  const tie: Prisma.JournalEntryWhereInput = {
    OR: [
      { createdAt: { lt: createdAt } },
      { createdAt, id: { lt: c.id } },
    ],
  };
  const sameDate: Prisma.JournalEntryWhereInput =
    c.voucherNumber != null
      ? {
          date,
          OR: [
            { voucherNumber: { lt: c.voucherNumber } },
            { voucherNumber: null },
            { voucherNumber: c.voucherNumber, ...tie },
          ],
        }
      : { date, voucherNumber: null, ...tie };
  return { OR: [{ date: { lt: date } }, sameDate] };
}

export const ENTRIES_ORDER: Prisma.JournalEntryOrderByWithRelationInput[] = [
  { date: "desc" },
  { voucherNumber: { sort: "desc", nulls: "last" } },
  { createdAt: "desc" },
  { id: "desc" },
];

export function encodeCursor(c: EntriesCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

export function decodeCursor(raw: string | null | undefined): EntriesCursor | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      typeof j?.date !== "string" ||
      typeof j?.createdAt !== "string" ||
      typeof j?.id !== "string" ||
      !(j.voucherNumber === null || typeof j.voucherNumber === "number")
    ) {
      return null;
    }
    if (Number.isNaN(new Date(j.date).getTime()) || Number.isNaN(new Date(j.createdAt).getTime())) {
      return null;
    }
    return { date: j.date, voucherNumber: j.voucherNumber, createdAt: j.createdAt, id: j.id };
  } catch {
    return null;
  }
}

export type EntryListItem = {
  id: string;
  date: string;
  voucherNumber: number | null;
  source: string;
  memo: string | null;
  thirdPartyName: string | null;
  thirdPartyTaxId: string | null;
  status: string;
  annulledAt: string | null;
  reversalOfId: string | null;
  /** Σ débitos (= Σ créditos en un asiento cuadrado). */
  totalCents: number;
  lineCount: number;
};

/** Una tanda del libro + cursor de la siguiente + total del conjunto filtrado. */
export async function listEntries(
  restaurantId: string,
  params: EntriesParams & { cursor?: string | null; limit?: number | null },
): Promise<{ entries: EntryListItem[]; nextCursor: string | null; total: number }> {
  const base = buildEntriesWhere(restaurantId, params);
  const cursor = decodeCursor(params.cursor);
  const limit = Math.min(
    Math.max(1, Math.floor(params.limit ?? ENTRIES_PAGE_SIZE)),
    ENTRIES_PAGE_MAX,
  );
  const where: Prisma.JournalEntryWhereInput = cursor
    ? { AND: [base, buildCursorWhere(cursor)] }
    : base;
  const [rows, total] = await Promise.all([
    db.journalEntry.findMany({
      where,
      orderBy: ENTRIES_ORDER,
      // Una fila de más para saber si hay tanda siguiente sin un COUNT extra.
      take: limit + 1,
      include: { lines: { select: { debitCents: true } } },
    }),
    db.journalEntry.count({ where: base }),
  ]);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    entries: page.map((e) => ({
      id: e.id,
      date: e.date.toISOString(),
      voucherNumber: e.voucherNumber,
      source: e.source,
      memo: e.memo,
      thirdPartyName: e.thirdPartyName,
      thirdPartyTaxId: e.thirdPartyTaxId,
      status: e.status,
      annulledAt: e.annulledAt ? e.annulledAt.toISOString() : null,
      reversalOfId: e.reversalOfId,
      totalCents: e.lines.reduce((s, l) => s + l.debitCents, 0),
      lineCount: e.lines.length,
    })),
    nextCursor:
      hasMore && last
        ? encodeCursor({
            date: last.date.toISOString(),
            voucherNumber: last.voucherNumber,
            createdAt: last.createdAt.toISOString(),
            id: last.id,
          })
        : null,
    total,
  };
}

// ── Detalle ─────────────────────────────────────────────────────────────────

export type EntryDetailLine = {
  id: string;
  accountCode: string;
  accountName: string;
  costCenterId: string | null;
  costCenterName: string | null;
  debitCents: number;
  creditCents: number;
  memo: string | null;
};

export type EntryDetail = {
  id: string;
  date: string;
  voucherNumber: number | null;
  source: string;
  memo: string | null;
  thirdPartyName: string | null;
  thirdPartyTaxId: string | null;
  status: string;
  annulledAt: string | null;
  createdAt: string;
  /** Si este comprobante es una reversa: el original (si todavía existe). */
  reversalOf: { id: string; voucherNumber: number | null } | null;
  reversalOfId: string | null;
  /** Si este comprobante fue reversado: la reversa. */
  reversedBy: { id: string; voucherNumber: number | null } | null;
  lines: EntryDetailLine[];
  totalDebitCents: number;
  totalCreditCents: number;
  balanced: boolean;
  monthClosed: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canReverse: boolean;
};

/** Comprobante con líneas (ordenadas por código), nombres y permisos. */
export async function loadEntryDetail(
  restaurantId: string,
  entryId: string,
): Promise<EntryDetail | null> {
  const entry = await db.journalEntry.findFirst({
    where: { id: entryId, restaurantId },
    include: {
      lines: {
        orderBy: { accountCode: "asc" },
        include: { costCenter: { select: { name: true } } },
      },
    },
  });
  if (!entry) return null;
  const [cfg, accounts, reversalOf, reversedBy] = await Promise.all([
    getAccountingConfig(restaurantId),
    db.ledgerAccount.findMany({
      where: { restaurantId, code: { in: [...new Set(entry.lines.map((l) => l.accountCode))] } },
      select: { code: true, name: true },
    }),
    entry.reversalOfId
      ? db.journalEntry.findFirst({
          where: { id: entry.reversalOfId, restaurantId },
          select: { id: true, voucherNumber: true },
        })
      : Promise.resolve(null),
    db.journalEntry.findFirst({
      where: { restaurantId, reversalOfId: entry.id },
      select: { id: true, voucherNumber: true },
    }),
  ]);
  const nameByCode = new Map(accounts.map((a) => [a.code, a.name]));
  const totalDebitCents = entry.lines.reduce((s, l) => s + l.debitCents, 0);
  const totalCreditCents = entry.lines.reduce((s, l) => s + l.creditCents, 0);
  const mutable = canMutateManual(entry, cfg.closedThrough).ok;
  return {
    id: entry.id,
    date: entry.date.toISOString(),
    voucherNumber: entry.voucherNumber,
    source: entry.source,
    memo: entry.memo,
    thirdPartyName: entry.thirdPartyName,
    thirdPartyTaxId: entry.thirdPartyTaxId,
    status: entry.status,
    annulledAt: entry.annulledAt ? entry.annulledAt.toISOString() : null,
    createdAt: entry.createdAt.toISOString(),
    reversalOf,
    reversalOfId: entry.reversalOfId,
    reversedBy,
    lines: entry.lines.map((l) => ({
      id: l.id,
      accountCode: l.accountCode,
      accountName: nameByCode.get(l.accountCode) ?? "—",
      costCenterId: l.costCenterId,
      costCenterName: l.costCenter?.name ?? null,
      debitCents: l.debitCents,
      creditCents: l.creditCents,
      memo: l.memo,
    })),
    totalDebitCents,
    totalCreditCents,
    balanced: totalDebitCents === totalCreditCents,
    monthClosed: isMonthClosed(cfg.closedThrough, monthOf(entry.date)),
    canEdit: mutable,
    canDelete: mutable,
    canReverse: canReverse(entry, cfg.closedThrough).ok,
  };
}
