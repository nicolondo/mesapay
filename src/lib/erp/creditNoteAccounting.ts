// Contabilidad de las NOTAS CRÉDITO electrónicas — capa con base de datos.
// La regla (pura y probada) vive en `creditNoteLedger.ts`; acá se lee y se
// fija lo que esa regla necesita:
//
//  · `stampCreditNoteAccounting`: después de que la DIAN acepta una nota,
//    fija UNA vez cuánto de ella cancela cartera de crédito de cliente
//    (`CreditNote.receivableCents`) y baja esa deuda en los cargos a
//    crédito de la cuenta (`Payment.creditNoteCents`). Fijarlo una vez es
//    lo que hace que el asiento regenerable salga siempre igual aunque
//    después entren abonos.
//  · `loadCreditNoteMonthPosting` / `loadRefundMonthPosting`: lo que el
//    motor (`posting.ts`) asienta en «Notas crédito» (por día fiscal de cada
//    nota) y cuánto de cada reembolso («Devoluciones», por día) cancela el
//    pasivo de una nota.
//  · `loadUnlinkedRefundsCents`: reembolsos del período que NO están
//    cubiertos por una nota (los reportes de impuestos sólo restan esos;
//    los ligados a una nota ya los resta la nota).
//
// Sólo cuentan notas ACEPTADAS por la DIAN (`DianDocument.state =
// "accepted"`) y no descartadas: una rechazada o descartada no existe
// fiscalmente.
//
// PROPINA DEVUELTA (ver `creditNoteTips.ts`): la nota de anulación también
// le devuelve al cliente la propina de la cuenta, que no va en la factura
// electrónica. Se fija con la nota (`tipRefundCents`; las notas anteriores a
// la regla la calculan acá la primera vez) y su parte de cartera
// (`tipReceivableCents`) en el mismo sello que la parte fiscal. En el asiento
// es D propinas por pagar · C Clientes / reintegros por pagar.
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
  creditNoteTipTargetMonth,
  matchOrderNotesAndRefunds,
  monthOfIsoDate,
  noteAvailableCents,
  NO_TIP_POSTING,
  refundLinkedCents,
  type CreditNotePosting,
  type CreditNoteSlicesResult,
  type OrderMatch,
} from "./creditNoteLedger";
import { creditNoteTipRefundCents, invoiceTipCents, type InvoiceTipSource } from "./creditNoteTips";
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

// ── Propina de la factura ─────────────────────────────────────────────────

/**
 * Lo que la regla de la propina necesita de la factura: la propina de la
 * cuenta y sus cobros. null = la factura no es de este comercio.
 */
export async function loadInvoiceTipSource(
  client: Client,
  restaurantId: string,
  invoiceId: string,
): Promise<InvoiceTipSource | null> {
  const invoice = await client.simpleInvoice.findFirst({
    where: { id: invoiceId, restaurantId },
    select: { order: { select: { tipCents: true, payments: { select: { status: true, tipCents: true } } } } },
  });
  if (!invoice) return null;
  return { orderTipCents: invoice.order.tipCents, payments: invoice.order.payments };
}

/** Propina de la factura (0 si no hay datos): la que devolvería una anulación. */
export async function loadInvoiceTipCents(client: Client, restaurantId: string, invoiceId: string): Promise<number> {
  const source = await loadInvoiceTipSource(client, restaurantId, invoiceId);
  return source ? invoiceTipCents(source) : 0;
}

// ── Fijar los datos contables tras la aceptación ─────────────────────────

const CREDIT_CHARGE_STATUSES = ["approved", "refunded"] as const;

/** Notas aceptadas a las que les falta fijar la parte fiscal o la propina. */
const unstampedWhere = (restaurantId: string): Prisma.CreditNoteWhereInput => ({
  ...acceptedCreditNoteWhere(restaurantId),
  OR: [{ accountingStampedAt: null }, { tipReceivableCents: null }],
});

/**
 * Fija los datos contables de una nota aceptada, UNA vez:
 *  · `receivableCents`: cuánto de la nota cancela cartera de crédito de
 *    cliente (si la cuenta se cobró a crédito y ese crédito sigue con saldo);
 *  · `tipRefundCents` (si la nota es anterior a la regla de la propina) y
 *    `tipReceivableCents`: la propina que devuelve y la parte de ella que
 *    cancela cartera, contra el saldo que dejó la parte fiscal.
 * Lo que cancela cartera baja también la deuda de los cargos a crédito de la
 * cuenta (`Payment.creditNoteCents`), en orden cronológico. Fijarlo una vez
 * es lo que hace que el asiento regenerable salga siempre igual aunque
 * después entren abonos. Una nota ya fijada antes de la regla sólo fija su
 * propina. Idempotente; devuelve true si fijó algo ahora.
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
      where: { ...unstampedWhere(restaurantId), id: creditNoteId },
      select: {
        id: true,
        totalCents: true,
        reasonCode: true,
        receivableCents: true,
        accountingStampedAt: true,
        tipRefundCents: true,
        originalInvoice: { select: { orderId: true, order: { select: { tipCents: true } } } },
      },
    });
    if (!note) return false;
    const payments = await tx.payment.findMany({
      where: { orderId: note.originalInvoice.orderId },
      select: { id: true, method: true, status: true, tipCents: true, billingCustomerId: true },
      orderBy: [{ settledAt: "asc" }, { createdAt: "asc" }],
    });
    // Notas anteriores a la regla: la propina se calcula ahora, con la misma
    // regla que usa la creación de notas nuevas.
    const tipRefundCents =
      note.tipRefundCents ??
      creditNoteTipRefundCents(note.reasonCode, {
        orderTipCents: note.originalInvoice.order?.tipCents,
        payments,
      });
    const charges = payments.filter(
      (p) =>
        p.method === "customer_credit" &&
        (CREDIT_CHARGE_STATUSES as readonly string[]).includes(p.status) &&
        p.billingCustomerId != null,
    );
    const fiscalStamped = note.accountingStampedAt != null;
    let receivableCents = note.receivableCents ?? 0;
    let tipReceivableCents = 0;
    const increments = new Map<string, number>();
    if (charges.length > 0) {
      const customerIds = [...new Set(charges.map((c) => c.billingCustomerId!))].sort();
      const outstanding = new Map<string, number>();
      for (const customerId of customerIds) {
        await tx.$queryRaw`SELECT id FROM "BillingCustomer" WHERE id = ${customerId} FOR UPDATE`;
        const summary = await loadCustomerCreditSummary(restaurantId, customerId, tx);
        for (const c of summary?.fifo.charges ?? []) outstanding.set(c.chargeId, c.outstandingCents);
      }
      const allocate = (amount: number) => {
        const allocation = allocateReceivable(
          amount,
          charges.map((c) => ({ id: c.id, outstandingCents: outstanding.get(c.id) ?? 0 })),
        );
        for (const part of allocation.perCharge) {
          increments.set(part.id, (increments.get(part.id) ?? 0) + part.cents);
          outstanding.set(part.id, (outstanding.get(part.id) ?? 0) - part.cents);
        }
        return allocation.receivableCents;
      };
      // Primero la parte fiscal (si falta) y con lo que quede, la propina.
      if (!fiscalStamped) receivableCents = allocate(note.totalCents);
      tipReceivableCents = allocate(tipRefundCents);
    }
    for (const [id, cents] of increments) {
      await tx.payment.update({ where: { id }, data: { creditNoteCents: { increment: cents } } });
    }
    const stamped = await tx.creditNote.updateMany({
      where: {
        id: note.id,
        restaurantId,
        tipReceivableCents: null,
        ...(fiscalStamped ? {} : { accountingStampedAt: null }),
      },
      data: {
        ...(fiscalStamped ? {} : { receivableCents, accountingStampedAt: now }),
        tipRefundCents,
        tipReceivableCents,
      },
    });
    if (stamped.count !== 1) throw new Error("credit_note_stamp_conflict");
    return true;
  });
}

/**
 * Fija las notas aceptadas que quedaron sin fijar (el proceso que recibió
 * la aceptación murió antes, o la nota es anterior a esta contabilidad o a
 * la regla de la propina). Barato: normalmente no hay ninguna.
 */
export async function ensureCreditNoteStamps(restaurantId: string): Promise<void> {
  const pending = await db.creditNote.findMany({
    where: unstampedWhere(restaurantId),
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
  tipRefundCents: true,
  tipReceivableCents: true,
  tipPostedMonth: true,
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
        // Parte fiscal fuera de cartera + propina devuelta fuera de cartera:
        // un reembolso posterior de lo cobrado (comida y propina) cancela
        // ese pasivo sin volver a debitar devoluciones.
        availableCents: noteAvailableCents(n),
      }));
    const orderRefunds = refunds
      .filter((r) => r.payment?.orderId === orderId)
      .map((r) => ({ id: r.id, at: r.createdAt, amountCents: r.amountCents }));
    out.set(orderId, matchOrderNotesAndRefunds(orderNotes, orderRefunds));
  }
  return out;
}

export type CreditNoteMonthPostingNote = CreditNotePosting & {
  fiscalDate: string;
  /**
   * ¿La parte FISCAL de la nota entra en este mes? (default true). Una nota
   * asentada en un mes que se cerró antes de la regla de la propina aparece
   * en el primer mes abierto sólo con su propina (`postsFiscal: false`).
   */
  postsFiscal?: boolean;
  /** ¿La propina devuelta entra en este mes? Se marca `tipPostedMonth`. */
  postsTip?: boolean;
};

export type CreditNoteMonthPosting = {
  /**
   * Lo que aporta cada nota al asiento (sólo las que cuadran), con su fecha
   * FISCAL ("YYYY-MM-DD", día colombiano de emisión): el motor asienta las
   * notas por ese día; una nota contabilizada en un mes distinto al de su
   * fecha fiscal (mes cerrado → primer mes abierto) va al último día del mes.
   * Lo que no entra en el mes (parte fiscal o propina) viene en 0.
   */
  notes: CreditNoteMonthPostingNote[];
  /** Notas cuya parte fiscal entra en el mes: se marcan con `postedMonth`. */
  noteIds: string[];
  /** Notas cuya propina devuelta entra en el mes: se marcan con `tipPostedMonth`. */
  tipNoteIds: string[];
};

/**
 * Notas de los asientos «Notas crédito» de `month`: las ya asentadas en
 * ese mes y las pendientes cuyo mes contable (fiscal, o el primer mes
 * abierto si el fiscal está cerrado) es `month`. La propina devuelta va con
 * su nota; sólo si la nota ya estaba asentada en un mes cerrado, va al
 * primer mes abierto (`creditNoteTipTargetMonth`).
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
        OR: [{ postedMonth: month }, { postedMonth: null }, { tipPostedMonth: month }, { tipPostedMonth: null }],
      },
      select: NOTE_SELECT,
      orderBy: { createdAt: "asc" },
    }),
  ]);
  const selected: {
    row: NoteRow;
    fiscalDate: string;
    postsFiscal: boolean;
    postsTip: boolean;
    slices: Extract<CreditNoteSlicesResult, { ok: true }>["slices"];
  }[] = [];
  for (const row of candidates) {
    const fiscalDate = creditNoteFiscalDate(creditNoteInstant(row));
    const fiscalMonth = monthOfIsoDate(fiscalDate);
    const postsFiscal = belongsToMonth({ postedMonth: row.postedMonth, fiscalMonth }, month, cfg.closedThrough);
    // La propina sólo se asienta ya fijada (sello de la propina hecho).
    const postsTip =
      row.tipReceivableCents != null &&
      (row.tipPostedMonth ?? creditNoteTipTargetMonth({ postedMonth: row.postedMonth, fiscalMonth }, cfg.closedThrough)) ===
        month;
    if (!postsFiscal && !postsTip) continue;
    const slices = storedNoteSlices(row);
    if (!slices.ok) {
      logInvalidCreditNote(row.id, row.documentNumber, slices.reason);
      continue;
    }
    selected.push({ row, fiscalDate, postsFiscal, postsTip, slices: slices.slices });
  }
  const matches = await loadOrderMatches(
    db,
    restaurantId,
    [...new Set(selected.map((s) => s.row.originalInvoice.orderId))],
  );
  const notes = selected.map(({ row, fiscalDate, postsFiscal, postsTip, slices }) => {
    const full = creditNotePosting({
      id: row.id,
      slices,
      totalCents: row.totalCents,
      receivableCents: row.receivableCents ?? 0,
      coveredByPriorRefundsCents:
        matches.get(row.originalInvoice.orderId)?.notes.get(row.id)?.coveredByPriorRefundsCents ?? 0,
      tipRefundCents: row.tipRefundCents ?? 0,
      tipReceivableCents: row.tipReceivableCents ?? 0,
    });
    return {
      id: full.id,
      slices: postsFiscal ? full.slices : [],
      receivableCents: postsFiscal ? full.receivableCents : 0,
      liabilityCents: postsFiscal ? full.liabilityCents : 0,
      tip: postsTip ? full.tip : { ...NO_TIP_POSTING },
      fiscalDate,
      postsFiscal,
      postsTip,
    };
  });
  return {
    notes,
    noteIds: notes.filter((n) => n.postsFiscal).map((n) => n.id),
    tipNoteIds: notes.filter((n) => n.postsTip).map((n) => n.id),
  };
}

/** Reembolsos de un rango con el pedido de su cobro. */
async function loadRefundsInRange(restaurantId: string, from: Date, to: Date) {
  return db.kushkiTransaction.findMany({
    where: { restaurantId, kind: "refund", createdAt: { gte: from, lt: to } },
    select: { id: true, amountCents: true, createdAt: true, payment: { select: { orderId: true } } },
    orderBy: { createdAt: "asc" },
  });
}

export type RefundPosting = {
  id: string;
  /** Instante del reembolso: define su día de negocio. */
  createdAt: Date;
  amountCents: number;
  /**
   * Parte que cancela el pasivo «reintegros por pagar» de una nota ANTERIOR
   * del mismo pedido (no vuelve a debitar devoluciones). Siempre ≤ `amountCents`.
   */
  liabilityCents: number;
};

export type RefundMonthPosting = {
  /** Cada reembolso del rango con su cruce (el motor los agrupa por día). */
  refunds: RefundPosting[];
  /** Σ `amountCents`. */
  totalCents: number;
  /** Σ `liabilityCents`. */
  liabilityCents: number;
};

/**
 * Reembolsos del rango para los asientos «Devoluciones»: cada uno con la
 * parte que cancela el pasivo «reintegros por pagar» de una nota ANTERIOR
 * del mismo pedido. El cruce nota ↔ reembolso es por pedido y con toda su
 * historia (no depende del rango), así que repartirlo por día es exacto:
 * Σ días == mes.
 */
export async function loadRefundMonthPosting(
  restaurantId: string,
  range: MonthRange,
): Promise<RefundMonthPosting> {
  const rows = await loadRefundsInRange(restaurantId, range.from, range.to);
  const orderIds = [...new Set(rows.map((r) => r.payment?.orderId).filter((x): x is string => !!x))];
  const matches = orderIds.length > 0 ? await loadOrderMatches(db, restaurantId, orderIds) : new Map();
  const refunds: RefundPosting[] = rows.map((r) => {
    const orderId = r.payment?.orderId;
    const liabilityCents = orderId ? matches.get(orderId)?.refunds.get(r.id)?.liabilityDebitCents ?? 0 : 0;
    return { id: r.id, createdAt: r.createdAt, amountCents: r.amountCents, liabilityCents };
  });
  return {
    refunds,
    totalCents: refunds.reduce((s, r) => s + r.amountCents, 0),
    liabilityCents: refunds.reduce((s, r) => s + r.liabilityCents, 0),
  };
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
