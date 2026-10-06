// Contabilidad de las NOTAS CRÉDITO electrónicas — capa con base de datos.
// La regla (pura y probada) vive en `creditNoteLedger.ts`; acá se lee y se
// fija lo que esa regla necesita:
//
//  · `stampCreditNoteAccounting`: después de que la DIAN acepta una nota,
//    fija UNA vez cuánto de ella cancela cartera de crédito de cliente
//    (`CreditNote.receivableCents`) y baja esa deuda en los cargos a
//    crédito de la cuenta (`Payment.creditNoteCents`). Fijarlo una vez es
//    lo que hace que el asiento mensual regenerable salga siempre igual
//    aunque después entren abonos.
//  · `loadCreditNoteMonthPosting` / `loadRefundMonthPosting`: lo que el
//    motor (`posting.ts`) asienta en «Notas crédito del mes» y cuánto de
//    «Devoluciones del mes» cancela el pasivo de una nota.
//  · `loadUnlinkedRefundsCents`: reembolsos del período que NO están
//    cubiertos por una nota (los reportes de impuestos sólo restan esos;
//    los ligados a una nota ya los resta la nota).
//
// Sólo cuentan notas ACEPTADAS por la DIAN (`DianDocument.state =
// "accepted"`) y no descartadas: una rechazada o descartada no existe
// fiscalmente.
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { loadCustomerCreditSummary } from "@/lib/customerCredit";
import type { CreditNoteSnapshot } from "@/lib/dian/creditNotes/types";
import { getAccountingConfig } from "./cierre";
import {
  allocateReceivable,
  belongsToMonth,
  creditNoteFiscalDate,
  creditNotePosting,
  creditNoteTaxSlices,
  matchOrderNotesAndRefunds,
  monthOfIsoDate,
  refundLinkedCents,
  type CreditNotePosting,
  type CreditNoteSlicesResult,
  type OrderMatch,
} from "./creditNoteLedger";
import type { MonthRange } from "./accountingData";

type Client = Prisma.TransactionClient | typeof db;

/** Notas que existen fiscalmente: aceptadas por la DIAN y no descartadas. */
export function acceptedCreditNoteWhere(restaurantId: string): Prisma.CreditNoteWhereInput {
  return { restaurantId, abandonedAt: null, dianDocument: { is: { state: "accepted" } } };
}

/** Instante fiscal de una nota: el `issuedAt` firmado (fallback: creación). */
export function creditNoteInstant(note: {
  createdAt: Date;
  dianDocument: { issuedAt: Date | null } | null;
}): Date {
  return note.dianDocument?.issuedAt ?? note.createdAt;
}

/**
 * Ventana de `issuedAt` que contiene todos los días fiscales [desde, hasta]
 * (con holgura de un día por la hora de Colombia). Se filtra fino en
 * memoria con `inFiscalRange`.
 */
export function issuedAtWindow(desde: string, hasta: string): { gte: Date; lt: Date } {
  const from = new Date(`${desde}T00:00:00.000Z`);
  const to = new Date(`${hasta}T00:00:00.000Z`);
  return {
    gte: new Date(from.getTime() - 86_400_000),
    lt: new Date(to.getTime() + 2 * 86_400_000),
  };
}

/** ¿La fecha fiscal de la nota cae en [desde, hasta] (ambos incluidos)? */
export function inFiscalRange(instant: Date, desde: string, hasta: string): boolean {
  const date = creditNoteFiscalDate(instant);
  return date >= desde && date <= hasta;
}

/** Tramos validados de una nota guardada (lee `snapshot.lines`). */
export function storedNoteSlices(note: {
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  snapshot: Prisma.JsonValue;
}): CreditNoteSlicesResult {
  const snapshot = note.snapshot as unknown as CreditNoteSnapshot | null;
  return creditNoteTaxSlices({
    subtotalCents: note.subtotalCents,
    taxCents: note.taxCents,
    totalCents: note.totalCents,
    lines: Array.isArray(snapshot?.lines) ? snapshot.lines : [],
  });
}

const warned = new Set<string>();
/** Log de una nota que no cuadra (una vez por proceso y nota). */
export function logInvalidCreditNote(id: string, documentNumber: string, reason: string): void {
  if (warned.has(id)) return;
  warned.add(id);
  console.error("[creditNotes] nota crédito que no cuadra — excluida de contabilidad e impuestos", {
    creditNoteId: id,
    documentNumber,
    reason,
  });
}

// ── Fijar los datos contables tras la aceptación ─────────────────────────

const CREDIT_CHARGE_STATUSES = ["approved", "refunded"] as const;

/**
 * Fija `receivableCents` de una nota aceptada y baja la deuda del cliente
 * si la cuenta se cobró a crédito y ese crédito sigue con saldo. Idempotente
 * (sólo actúa si la nota no está fijada). Devuelve true si la fijó ahora.
 *
 * Bajo el lock de los clientes (el mismo que toman los abonos) para que un
 * abono simultáneo no se cruce con el cálculo del saldo FIFO.
 */
export async function stampCreditNoteAccounting(
  restaurantId: string,
  creditNoteId: string,
  now: Date = new Date(),
): Promise<boolean> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${restaurantId}), 948)`;
    const note = await tx.creditNote.findFirst({
      where: { ...acceptedCreditNoteWhere(restaurantId), id: creditNoteId, accountingStampedAt: null },
      select: { id: true, totalCents: true, originalInvoice: { select: { orderId: true } } },
    });
    if (!note) return false;
    const charges = await tx.payment.findMany({
      where: {
        orderId: note.originalInvoice.orderId,
        method: "customer_credit",
        status: { in: [...CREDIT_CHARGE_STATUSES] },
        billingCustomerId: { not: null },
      },
      select: { id: true, billingCustomerId: true },
      orderBy: [{ settledAt: "asc" }, { createdAt: "asc" }],
    });
    let receivableCents = 0;
    if (charges.length > 0) {
      const customerIds = [...new Set(charges.map((c) => c.billingCustomerId!))].sort();
      const outstanding = new Map<string, number>();
      for (const customerId of customerIds) {
        await tx.$queryRaw`SELECT id FROM "BillingCustomer" WHERE id = ${customerId} FOR UPDATE`;
        const summary = await loadCustomerCreditSummary(restaurantId, customerId, tx);
        for (const c of summary?.fifo.charges ?? []) outstanding.set(c.chargeId, c.outstandingCents);
      }
      const allocation = allocateReceivable(
        note.totalCents,
        charges.map((c) => ({ id: c.id, outstandingCents: outstanding.get(c.id) ?? 0 })),
      );
      receivableCents = allocation.receivableCents;
      for (const part of allocation.perCharge) {
        await tx.payment.update({
          where: { id: part.id },
          data: { creditNoteCents: { increment: part.cents } },
        });
      }
    }
    const stamped = await tx.creditNote.updateMany({
      where: { id: note.id, restaurantId, accountingStampedAt: null },
      data: { receivableCents, accountingStampedAt: now },
    });
    if (stamped.count !== 1) throw new Error("credit_note_stamp_conflict");
    return true;
  });
}

/**
 * Fija las notas aceptadas que quedaron sin fijar (el proceso que recibió
 * la aceptación murió antes, o la nota es anterior a esta contabilidad).
 * Barato: normalmente no hay ninguna.
 */
export async function ensureCreditNoteStamps(restaurantId: string): Promise<void> {
  const pending = await db.creditNote.findMany({
    where: { ...acceptedCreditNoteWhere(restaurantId), accountingStampedAt: null },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  for (const n of pending) {
    try {
      await stampCreditNoteAccounting(restaurantId, n.id);
    } catch (error) {
      console.error("[creditNotes] no se pudo fijar la contabilidad de la nota", {
        creditNoteId: n.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

// ── Notas y reembolsos por pedido ─────────────────────────────────────────

const NOTE_SELECT = {
  id: true,
  documentNumber: true,
  subtotalCents: true,
  taxCents: true,
  totalCents: true,
  snapshot: true,
  receivableCents: true,
  postedMonth: true,
  createdAt: true,
  dianDocument: { select: { issuedAt: true } },
  originalInvoice: { select: { orderId: true } },
} as const;

type NoteRow = Prisma.CreditNoteGetPayload<{ select: typeof NOTE_SELECT }>;

/**
 * Cruce notas ↔ reembolsos de cada pedido, con TODA su historia (no sólo
 * el mes): la regla es cronológica. Sólo entran notas fijadas y que cuadran.
 */
async function loadOrderMatches(
  client: Client,
  restaurantId: string,
  orderIds: readonly string[],
): Promise<Map<string, OrderMatch>> {
  const out = new Map<string, OrderMatch>();
  if (orderIds.length === 0) return out;
  const [notes, refunds] = await Promise.all([
    client.creditNote.findMany({
      where: {
        ...acceptedCreditNoteWhere(restaurantId),
        accountingStampedAt: { not: null },
        originalInvoice: { orderId: { in: [...orderIds] } },
      },
      select: NOTE_SELECT,
    }),
    client.kushkiTransaction.findMany({
      where: { restaurantId, kind: "refund", payment: { orderId: { in: [...orderIds] } } },
      select: { id: true, amountCents: true, createdAt: true, payment: { select: { orderId: true } } },
    }),
  ]);
  for (const orderId of orderIds) {
    const orderNotes = notes
      .filter((n) => n.originalInvoice.orderId === orderId && storedNoteSlices(n).ok)
      .map((n) => ({
        id: n.id,
        at: creditNoteInstant(n),
        availableCents: n.totalCents - (n.receivableCents ?? 0),
      }));
    const orderRefunds = refunds
      .filter((r) => r.payment?.orderId === orderId)
      .map((r) => ({ id: r.id, at: r.createdAt, amountCents: r.amountCents }));
    out.set(orderId, matchOrderNotesAndRefunds(orderNotes, orderRefunds));
  }
  return out;
}

export type CreditNoteMonthPosting = {
  /** Lo que aporta cada nota al asiento (sólo las que cuadran). */
  notes: CreditNotePosting[];
  /** Notas que el asiento del mes considera: se marcan con `postedMonth`. */
  noteIds: string[];
};

/**
 * Notas del asiento «Notas crédito del mes» de `month`: las ya asentadas en
 * ese mes y las pendientes cuyo mes contable (fiscal, o el primer mes
 * abierto si el fiscal está cerrado) es `month`.
 */
export async function loadCreditNoteMonthPosting(
  restaurantId: string,
  month: string,
): Promise<CreditNoteMonthPosting> {
  await ensureCreditNoteStamps(restaurantId);
  const [cfg, candidates] = await Promise.all([
    getAccountingConfig(restaurantId),
    db.creditNote.findMany({
      where: {
        ...acceptedCreditNoteWhere(restaurantId),
        accountingStampedAt: { not: null },
        OR: [{ postedMonth: month }, { postedMonth: null }],
      },
      select: NOTE_SELECT,
      orderBy: { createdAt: "asc" },
    }),
  ]);
  const selected: { row: NoteRow; slices: Extract<CreditNoteSlicesResult, { ok: true }>["slices"] }[] = [];
  for (const row of candidates) {
    const fiscalMonth = monthOfIsoDate(creditNoteFiscalDate(creditNoteInstant(row)));
    if (!belongsToMonth({ postedMonth: row.postedMonth, fiscalMonth }, month, cfg.closedThrough)) continue;
    const slices = storedNoteSlices(row);
    if (!slices.ok) {
      logInvalidCreditNote(row.id, row.documentNumber, slices.reason);
      continue;
    }
    selected.push({ row, slices: slices.slices });
  }
  const matches = await loadOrderMatches(
    db,
    restaurantId,
    [...new Set(selected.map((s) => s.row.originalInvoice.orderId))],
  );
  const notes = selected.map(({ row, slices }) =>
    creditNotePosting({
      id: row.id,
      slices,
      totalCents: row.totalCents,
      receivableCents: row.receivableCents ?? 0,
      coveredByPriorRefundsCents:
        matches.get(row.originalInvoice.orderId)?.notes.get(row.id)?.coveredByPriorRefundsCents ?? 0,
    }),
  );
  return { notes, noteIds: notes.map((n) => n.id) };
}

/** Reembolsos de un rango con el pedido de su cobro. */
async function loadRefundsInRange(restaurantId: string, from: Date, to: Date) {
  return db.kushkiTransaction.findMany({
    where: { restaurantId, kind: "refund", createdAt: { gte: from, lt: to } },
    select: { id: true, amountCents: true, payment: { select: { orderId: true } } },
  });
}

/**
 * Reembolsos del mes para el asiento «Devoluciones del mes»: el total y la
 * parte que cancela el pasivo «reintegros por pagar» de una nota ANTERIOR
 * del mismo pedido (esa parte no vuelve a debitar devoluciones).
 */
export async function loadRefundMonthPosting(
  restaurantId: string,
  range: MonthRange,
): Promise<{ totalCents: number; liabilityCents: number }> {
  const refunds = await loadRefundsInRange(restaurantId, range.from, range.to);
  const totalCents = refunds.reduce((s, r) => s + r.amountCents, 0);
  const orderIds = [...new Set(refunds.map((r) => r.payment?.orderId).filter((x): x is string => !!x))];
  if (orderIds.length === 0) return { totalCents, liabilityCents: 0 };
  const matches = await loadOrderMatches(db, restaurantId, orderIds);
  let liabilityCents = 0;
  for (const r of refunds) {
    const orderId = r.payment?.orderId;
    if (!orderId) continue;
    liabilityCents += matches.get(orderId)?.refunds.get(r.id)?.liabilityDebitCents ?? 0;
  }
  return { totalCents, liabilityCents };
}

/**
 * Σ reembolsos del rango que NO quedaron ligados a una nota crédito (ni
 * antes ni después). Es lo que los reportes de impuestos restan como
 * devolución estimada; lo ligado a una nota ya lo resta la nota con su
 * impuesto exacto.
 */
export async function loadUnlinkedRefundsCents(
  restaurantId: string,
  from: Date,
  to: Date,
): Promise<number> {
  // El cruce sólo ve notas fijadas: fija las aceptadas que quedaron sin
  // fijar para que su reembolso no se reste dos veces (como devolución y
  // dentro de la nota).
  await ensureCreditNoteStamps(restaurantId);
  const refunds = await loadRefundsInRange(restaurantId, from, to);
  const orderIds = [...new Set(refunds.map((r) => r.payment?.orderId).filter((x): x is string => !!x))];
  const matches = await loadOrderMatches(db, restaurantId, orderIds);
  let total = 0;
  for (const r of refunds) {
    const match = r.payment?.orderId ? matches.get(r.payment.orderId) : undefined;
    total += r.amountCents - (match ? refundLinkedCents(match, r.id) : 0);
  }
  return total;
}
