// Comprobantes manuales y reversas — equivalente TS de `post_journal_core`
// de zenith, adaptado al motor de MESAPAY.
//
// Reglas del asiento libre (en orden, como en zenith):
//   1. Al menos dos líneas, cada una con UN solo lado > 0 (débito o crédito,
//      enteros en centavos).
//   2. Partida doble: Σdébitos == Σcréditos y > 0.
//   3. Mes de la fecha ABIERTO (candado `closedThrough` de AccountingConfig).
//   4. Cuentas existentes, activas e imputables (`postable`); centro de
//      costos existente y activo si viene.
//
// Convivencia con el motor (posting.ts): `generateJournalForMonth` borra sus
// asientos-resumen por `(source, sourceRef = "YYYY-MM")` de SUS fuentes
// (posting.ts, `tx.journalEntry.deleteMany({ where: { restaurantId,
// source: e.source, sourceRef: month } })`). Los manuales llevan
// `source = "manual"` y un `sourceRef` único que NUNCA tiene forma de mes,
// así que sobreviven a cualquier regeneración. El cierre (cierre.ts) numera
// todo asiento sin número con fecha dentro del mes, sin mirar el origen, así
// que los manuales del mes también reciben comprobante al cerrar.
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { getAccountingConfig, isMonthClosed } from "./cierre";

export const MANUAL_SOURCE = "manual";

export type ManualLineInput = {
  accountCode: string;
  debitCents?: number | null;
  creditCents?: number | null;
  costCenterId?: string | null;
  memo?: string | null;
};

export type ManualEntryInput = {
  /** "YYYY-MM-DD". */
  date: string;
  memo: string;
  thirdPartyName?: string | null;
  thirdPartyTaxId?: string | null;
  lines: ManualLineInput[];
};

export type ManualEntryError =
  | "too_few_lines"
  | "line_empty"
  | "line_both_sides"
  | "line_invalid_amount"
  | "unbalanced"
  | "invalid_date"
  | "period_closed"
  | "account_not_found"
  | "account_inactive"
  | "account_not_postable"
  | "cost_center_not_found"
  | "invalid_memo"
  | "invalid_third_party";

export type ManualEntryContext = {
  closedThrough: string | null;
  /** Cuentas del comercio por código. */
  accounts: Map<string, { id: string; active: boolean; postable: boolean }>;
  /** Centros de costos del comercio por id. */
  costCenters: Map<string, { active: boolean }>;
};

export type NormalizedLine = {
  accountId: string;
  accountCode: string;
  debitCents: number;
  creditCents: number;
  costCenterId: string | null;
  memo: string | null;
};

export type NormalizedEntry = {
  date: Date;
  month: string;
  memo: string;
  thirdPartyName: string | null;
  thirdPartyTaxId: string | null;
  lines: NormalizedLine[];
  totalCents: number;
};

export type ValidationResult =
  | { ok: true; normalized: NormalizedEntry }
  | { ok: false; error: ManualEntryError; line?: number };

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TAX_ID_RE = /^[0-9-]{4,20}$/;

/**
 * "YYYY-MM-DD" → Date al MEDIODÍA UTC. Así la fecha calendario es la misma
 * en UTC y en America/Bogota (UTC−5), y cae dentro del rango UTC del mes que
 * usan `monthRange` (accounting.ts) y el cierre.
 */
export function parseEntryDate(ymd: string): Date | null {
  const m = DATE_RE.exec(ymd);
  if (!m) return null;
  const d = new Date(`${ymd}T12:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  // Rechaza fechas "normalizadas" por JS (2026-02-31 → 03-03).
  if (d.toISOString().slice(0, 10) !== ymd) return null;
  const year = Number(m[1]);
  if (year < 2020 || year > 2100) return null;
  return d;
}

/** "YYYY-MM" de una fecha, en UTC (misma convención que el motor). */
export function monthOf(date: Date): string {
  return date.toISOString().slice(0, 7);
}

/** Primer día del mes siguiente a `month` ("2026-03" → 2026-04-01, mediodía UTC). */
export function firstDayAfterMonth(month: string): Date {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y!, m!, 1, 12));
}

function isCents(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/**
 * Valida y normaliza un asiento manual. Pura: recibe el contexto (candado,
 * cuentas, centros) ya cargado. `line` en el error es 1-based.
 */
export function validateManualEntry(
  input: ManualEntryInput,
  ctx: ManualEntryContext,
): ValidationResult {
  const date = parseEntryDate(input.date ?? "");
  if (!date) return { ok: false, error: "invalid_date" };
  const month = monthOf(date);
  if (isMonthClosed(ctx.closedThrough, month)) {
    return { ok: false, error: "period_closed" };
  }

  const memo = (input.memo ?? "").trim();
  if (memo.length < 1 || memo.length > 300) {
    return { ok: false, error: "invalid_memo" };
  }

  const thirdPartyName = (input.thirdPartyName ?? "").trim() || null;
  const thirdPartyTaxId = (input.thirdPartyTaxId ?? "").trim() || null;
  if (thirdPartyName && (thirdPartyName.length < 2 || thirdPartyName.length > 160)) {
    return { ok: false, error: "invalid_third_party" };
  }
  if (thirdPartyTaxId && !TAX_ID_RE.test(thirdPartyTaxId)) {
    return { ok: false, error: "invalid_third_party" };
  }
  // NIT sin nombre no identifica a nadie.
  if (thirdPartyTaxId && !thirdPartyName) {
    return { ok: false, error: "invalid_third_party" };
  }

  const rawLines = Array.isArray(input.lines) ? input.lines : [];
  if (rawLines.length < 2) return { ok: false, error: "too_few_lines" };

  const lines: NormalizedLine[] = [];
  let debit = 0;
  let credit = 0;
  for (let i = 0; i < rawLines.length; i++) {
    const n = i + 1;
    const l = rawLines[i]!;
    const d = l.debitCents ?? 0;
    const c = l.creditCents ?? 0;
    if (!isCents(d) || !isCents(c)) {
      return { ok: false, error: "line_invalid_amount", line: n };
    }
    if (d > 0 && c > 0) return { ok: false, error: "line_both_sides", line: n };
    if (d === 0 && c === 0) return { ok: false, error: "line_empty", line: n };

    const code = (l.accountCode ?? "").trim();
    const account = ctx.accounts.get(code);
    if (!account) return { ok: false, error: "account_not_found", line: n };
    if (!account.active) return { ok: false, error: "account_inactive", line: n };
    if (!account.postable) {
      return { ok: false, error: "account_not_postable", line: n };
    }

    const costCenterId = (l.costCenterId ?? "").trim() || null;
    if (costCenterId) {
      const cc = ctx.costCenters.get(costCenterId);
      if (!cc || !cc.active) {
        return { ok: false, error: "cost_center_not_found", line: n };
      }
    }

    const lineMemo = (l.memo ?? "").trim().slice(0, 300) || null;
    lines.push({
      accountId: account.id,
      accountCode: code,
      debitCents: d,
      creditCents: c,
      costCenterId,
      memo: lineMemo,
    });
    debit += d;
    credit += c;
  }
  if (debit !== credit || debit === 0) {
    return { ok: false, error: "unbalanced" };
  }

  return {
    ok: true,
    normalized: {
      date,
      month,
      memo,
      thirdPartyName,
      thirdPartyTaxId,
      lines,
      totalCents: debit,
    },
  };
}

/** `#000123`; cadena vacía si el comprobante todavía no tiene número. */
export function formatVoucherNumber(n: number | null | undefined): string {
  if (n == null) return "";
  return `#${String(n).padStart(6, "0")}`;
}

// ── Acceso a datos ──────────────────────────────────────────────────────────

async function loadContext(restaurantId: string): Promise<ManualEntryContext> {
  const [cfg, accounts, centers] = await Promise.all([
    getAccountingConfig(restaurantId),
    db.ledgerAccount.findMany({
      where: { restaurantId },
      select: { id: true, code: true, active: true, postable: true },
    }),
    db.costCenter.findMany({
      where: { restaurantId },
      select: { id: true, active: true },
    }),
  ]);
  return {
    closedThrough: cfg.closedThrough,
    accounts: new Map(
      accounts.map((a) => [a.code, { id: a.id, active: a.active, postable: a.postable }]),
    ),
    costCenters: new Map(centers.map((c) => [c.id, { active: c.active }])),
  };
}

const ENTRY_INCLUDE = {
  lines: { orderBy: { accountCode: "asc" as const } },
} as const;

export type ManualEntryRecord = NonNullable<
  Awaited<ReturnType<typeof loadEntry>>
>;

async function loadEntry(restaurantId: string, entryId: string) {
  return db.journalEntry.findFirst({
    where: { id: entryId, restaurantId },
    include: ENTRY_INCLUDE,
  });
}

export type MutationError =
  | ManualEntryError
  | "not_found"
  | "not_manual"
  | "already_annulled"
  | "is_reversal";

export type MutationResult =
  | { ok: true; entry: ManualEntryRecord }
  | { ok: false; error: MutationError; line?: number };

/**
 * Crea un comprobante manual (asiento libre) con sus líneas en UNA
 * transacción. `sourceRef` es un identificador único que nunca coincide con
 * un "YYYY-MM": es lo que lo protege de la regeneración del motor.
 */
export async function createManualEntry(args: {
  restaurantId: string;
  actorId: string | null;
  input: ManualEntryInput;
}): Promise<MutationResult> {
  const ctx = await loadContext(args.restaurantId);
  const v = validateManualEntry(args.input, ctx);
  if (!v.ok) return v;
  const n = v.normalized;
  const entry = await db.$transaction(async (tx) =>
    tx.journalEntry.create({
      data: {
        restaurantId: args.restaurantId,
        date: n.date,
        source: MANUAL_SOURCE,
        sourceRef: randomUUID(),
        memo: n.memo,
        status: "posted",
        thirdPartyName: n.thirdPartyName,
        thirdPartyTaxId: n.thirdPartyTaxId,
        createdById: args.actorId,
        lines: { create: n.lines },
      },
      include: ENTRY_INCLUDE,
    }),
  );
  return { ok: true, entry };
}

/** ¿Se puede editar/borrar? Sólo manuales vigentes con el mes abierto. */
export function canMutateManual(
  entry: { source: string; date: Date; annulledAt: Date | null },
  closedThrough: string | null,
): { ok: true } | { ok: false; error: "not_manual" | "already_annulled" | "period_closed" } {
  if (entry.source !== MANUAL_SOURCE) return { ok: false, error: "not_manual" };
  if (entry.annulledAt) return { ok: false, error: "already_annulled" };
  if (isMonthClosed(closedThrough, monthOf(entry.date))) {
    return { ok: false, error: "period_closed" };
  }
  return { ok: true };
}

/**
 * ¿Se puede reversar? Cualquier origen con el mes CERRADO (no se puede
 * regenerar ni borrar: la reversa es la única corrección), o un manual con
 * el mes abierto si se prefiere dejar rastro en vez de borrar. Nunca dos
 * veces, nunca una reversa.
 */
export function canReverse(
  entry: { source: string; date: Date; annulledAt: Date | null; reversalOfId: string | null },
  closedThrough: string | null,
): { ok: true } | { ok: false; error: "already_annulled" | "is_reversal" | "not_manual" } {
  if (entry.annulledAt) return { ok: false, error: "already_annulled" };
  if (entry.reversalOfId) return { ok: false, error: "is_reversal" };
  const closed = isMonthClosed(closedThrough, monthOf(entry.date));
  if (!closed && entry.source !== MANUAL_SOURCE) {
    // Mes abierto + origen automático: se corrige regenerando, no reversando.
    return { ok: false, error: "not_manual" };
  }
  return { ok: true };
}

/**
 * Reemplaza cabecera y líneas de un comprobante manual. Exige mes abierto
 * tanto para la fecha VIEJA (no se puede sacar un asiento de un mes cerrado)
 * como para la NUEVA (la valida `validateManualEntry`).
 */
export async function updateManualEntry(args: {
  restaurantId: string;
  entryId: string;
  input: ManualEntryInput;
}): Promise<MutationResult> {
  const existing = await loadEntry(args.restaurantId, args.entryId);
  if (!existing) return { ok: false, error: "not_found" };
  const ctx = await loadContext(args.restaurantId);
  const gate = canMutateManual(existing, ctx.closedThrough);
  if (!gate.ok) return gate;
  const v = validateManualEntry(args.input, ctx);
  if (!v.ok) return v;
  const n = v.normalized;
  const entry = await db.$transaction(async (tx) => {
    await tx.journalLine.deleteMany({ where: { entryId: existing.id } });
    return tx.journalEntry.update({
      where: { id: existing.id },
      data: {
        date: n.date,
        memo: n.memo,
        thirdPartyName: n.thirdPartyName,
        thirdPartyTaxId: n.thirdPartyTaxId,
        lines: { create: n.lines },
      },
      include: ENTRY_INCLUDE,
    });
  });
  return { ok: true, entry };
}

/**
 * Borra un comprobante manual (mes abierto). Si era una reversa, el original
 * vuelve a "posted" (como `mcp_delete_journal_entry` de zenith); se usa
 * updateMany porque el original puede ya no existir (mes reabierto y
 * regenerado por el motor).
 */
export async function deleteManualEntry(args: {
  restaurantId: string;
  entryId: string;
}): Promise<{ ok: true } | { ok: false; error: MutationError }> {
  const existing = await loadEntry(args.restaurantId, args.entryId);
  if (!existing) return { ok: false, error: "not_found" };
  const cfg = await getAccountingConfig(args.restaurantId);
  const gate = canMutateManual(existing, cfg.closedThrough);
  if (!gate.ok) return gate;
  await db.$transaction(async (tx) => {
    await tx.journalEntry.delete({ where: { id: existing.id } });
    if (existing.reversalOfId) {
      await tx.journalEntry.updateMany({
        where: { id: existing.reversalOfId, restaurantId: args.restaurantId },
        data: { annulledAt: null, status: "posted" },
      });
    }
  });
  return { ok: true };
}

/** Memo de la reversa: número del original o, sin número, su fecha. */
export function reversalMemo(original: {
  voucherNumber: number | null;
  date: Date;
  memo: string | null;
}): string {
  const ref =
    original.voucherNumber != null
      ? formatVoucherNumber(original.voucherNumber)
      : original.date.toISOString().slice(0, 10);
  const base = `Reversa del comprobante ${ref}`;
  const memo = (original.memo ?? "").trim();
  return (memo ? `${base} — ${memo}` : base).slice(0, 300);
}

/**
 * Fecha de la reversa: la del original si su mes sigue abierto; si está
 * cerrado, el PRIMER día del primer mes abierto (closedThrough + 1 mes).
 * Por qué: un mes cerrado tiene comprobantes numerados en firme y estados
 * financieros ya entregados — no puede recibir asientos nuevos (el motor y
 * este módulo lo rechazan). La corrección se registra en el período abierto
 * más temprano, que es donde el contador la espera ver.
 */
export function reversalDate(originalDate: Date, closedThrough: string | null): Date {
  const month = monthOf(originalDate);
  if (!isMonthClosed(closedThrough, month)) return originalDate;
  return firstDayAfterMonth(closedThrough!);
}

/**
 * Reversa un comprobante: crea un asiento `manual` con las líneas invertidas
 * (mismos centros de costos, mismo tercero) y marca el original como anulado.
 * Las líneas del original SIGUEN en el libro — la reversa las netea — igual
 * que en zenith. No se puede reversar dos veces ni reversar una reversa.
 */
export async function reverseEntry(args: {
  restaurantId: string;
  entryId: string;
  actorId: string | null;
}): Promise<MutationResult> {
  const original = await loadEntry(args.restaurantId, args.entryId);
  if (!original) return { ok: false, error: "not_found" };
  const cfg = await getAccountingConfig(args.restaurantId);
  const gate = canReverse(original, cfg.closedThrough);
  if (!gate.ok) return gate;
  if (original.lines.length === 0) return { ok: false, error: "too_few_lines" };

  const date = reversalDate(original.date, cfg.closedThrough);
  const now = new Date();
  const entry = await db.$transaction(async (tx) => {
    const created = await tx.journalEntry.create({
      data: {
        restaurantId: args.restaurantId,
        date,
        source: MANUAL_SOURCE,
        sourceRef: randomUUID(),
        memo: reversalMemo(original),
        status: "posted",
        thirdPartyName: original.thirdPartyName,
        thirdPartyTaxId: original.thirdPartyTaxId,
        createdById: args.actorId,
        reversalOfId: original.id,
        lines: {
          create: original.lines.map((l) => ({
            accountId: l.accountId,
            accountCode: l.accountCode,
            debitCents: l.creditCents,
            creditCents: l.debitCents,
            costCenterId: l.costCenterId,
            memo: l.memo,
          })),
        },
      },
      include: ENTRY_INCLUDE,
    });
    await tx.journalEntry.update({
      where: { id: original.id },
      data: { annulledAt: now, status: "annulled" },
    });
    return created;
  });
  return { ok: true, entry };
}
