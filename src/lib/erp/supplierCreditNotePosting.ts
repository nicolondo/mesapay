// Asientos de las notas crédito de PROVEEDORES (bloque 9 del motor,
// posting.ts). Un asiento-resumen por fuente y día, como el resto:
//
//  · supplier_credit_note       Día de la FECHA de la nota (fecha contable,
//                               como los gastos). D 133005 saldo a favor ·
//                               C contrapartida (613575 acuerdos, 613570
//                               descuentos, 421040 pronto pago, 1435/5195
//                               devoluciones) · C 24081001 IVA descontable.
//  · supplier_credit_note_void  Día de la ANULACIÓN: el reverso exacto. La
//                               nota original se queda en su día (si su mes
//                               está cerrado, su asiento es firme y el
//                               reverso cae en el mes abierto).
//  · supplier_credit_apply      Día de cada cruce: D 220505 proveedores (el
//                               cruce con una compra) / D 233505 costos y
//                               gastos por pagar (con un gasto) · C 133005.
//  · supplier_credit_refund     Día del reintegro en dinero: D caja/banco
//                               donde entró · C 133005.
//
// Los cruces son abonos (PurchasePayment/ExpensePayment con
// `supplierCreditNoteId`): por eso posting.ts los saca de «Pagos a
// proveedores» y «Pagos de gastos» — no salió plata.
import { db } from "@/lib/db";
import { ENGINE } from "./engineCodes";
import {
  creditNotePostingLines,
  isSupplierCreditNoteKind,
  netPostingLines,
  reversePostingLines,
  type CreditNoteAmounts,
  type PostingLine,
} from "./supplierCreditNotes";

export type SupplierCreditDraft = {
  source: "supplier_credit_note" | "supplier_credit_note_void" | "supplier_credit_apply" | "supplier_credit_refund";
  memo: string;
  date: Date;
  day: string;
  lines: PostingLine[];
};

export type NoteFact = CreditNoteAmounts & { id: string; date: Date; voidedAt: Date | null };
export type ApplyFact = { target: "purchase" | "expense"; amountCents: number; at: Date };
export type RefundFact = { amountCents: number; accountCode: string; at: Date };

export type SupplierCreditFacts = {
  /** Notas cuya FECHA cae en el mes (vigentes o anuladas: su asiento original existe igual). */
  notes: NoteFact[];
  /** Notas ANULADAS cuya anulación cae en el mes. */
  voids: NoteFact[];
  applies: ApplyFact[];
  refunds: RefundFact[];
};

function byDay<T>(rows: readonly T[], dayOf: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const d = dayOf(r);
    const list = out.get(d);
    if (list) list.push(r);
    else out.set(d, [r]);
  }
  return new Map([...out.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Arma (puro) los asientos del mes. `calendarDay` resuelve las fechas
 * contables (mediodía de Colombia); `businessDay` los instantes (anulación,
 * cruces); `entryDate` fecha el asiento de un día.
 */
export function buildSupplierCreditEntries(
  facts: SupplierCreditFacts,
  fn: { calendarDay: (d: Date) => string; businessDay: (d: Date) => string; entryDate: (day: string) => Date },
): SupplierCreditDraft[] {
  const out: SupplierCreditDraft[] = [];
  for (const [day, notes] of byDay(facts.notes, (n) => fn.calendarDay(n.date))) {
    const lines = netPostingLines(notes.flatMap((n) => creditNotePostingLines(n)));
    if (lines.length) {
      out.push({ source: "supplier_credit_note", memo: "Notas crédito de proveedores del día", date: fn.entryDate(day), day, lines });
    }
  }
  for (const [day, notes] of byDay(facts.voids, (n) => fn.businessDay(n.voidedAt!))) {
    const lines = netPostingLines(notes.flatMap((n) => reversePostingLines(creditNotePostingLines(n))));
    if (lines.length) {
      out.push({ source: "supplier_credit_note_void", memo: "Anulación de notas crédito de proveedores", date: fn.entryDate(day), day, lines });
    }
  }
  for (const [day, rows] of byDay(facts.applies, (a) => fn.businessDay(a.at))) {
    const purchase = rows.filter((r) => r.target === "purchase").reduce((s, r) => s + r.amountCents, 0);
    const expense = rows.filter((r) => r.target === "expense").reduce((s, r) => s + r.amountCents, 0);
    const lines: PostingLine[] = [];
    if (purchase > 0) lines.push({ code: ENGINE.PROVEEDORES, debit: purchase });
    if (expense > 0) lines.push({ code: ENGINE.GASTOS_POR_PAGAR, debit: expense });
    if (purchase + expense > 0) {
      lines.push({ code: ENGINE.SALDO_A_FAVOR_PROVEEDORES, credit: purchase + expense });
      out.push({ source: "supplier_credit_apply", memo: "Cruces de saldos a favor de proveedores", date: fn.entryDate(day), day, lines });
    }
  }
  for (const [day, rows] of byDay(facts.refunds, (r) => fn.calendarDay(r.at))) {
    const byAccount = new Map<string, number>();
    for (const r of rows) if (r.amountCents > 0) byAccount.set(r.accountCode, (byAccount.get(r.accountCode) ?? 0) + r.amountCents);
    const total = [...byAccount.values()].reduce((s, v) => s + v, 0);
    if (total <= 0) continue;
    const lines: PostingLine[] = [...byAccount].map(([code, debit]) => ({ code, debit }));
    lines.push({ code: ENGINE.SALDO_A_FAVOR_PROVEEDORES, credit: total });
    out.push({ source: "supplier_credit_refund", memo: "Reintegros de saldos a favor de proveedores", date: fn.entryDate(day), day, lines });
  }
  return out;
}

const NOTE_SELECT = {
  id: true,
  kind: true,
  date: true,
  totalCents: true,
  ivaCents: true,
  incCents: true,
  ivaDeductible: true,
  accountCode: true,
  voidedAt: true,
  lines: { select: { valueCents: true, costCents: true, inventoried: true }, orderBy: { id: "asc" as const } },
} as const;

type NoteRow = {
  id: string;
  kind: string;
  date: Date;
  totalCents: number;
  ivaCents: number;
  incCents: number;
  ivaDeductible: boolean;
  accountCode: string | null;
  voidedAt: Date | null;
  lines: { valueCents: number; costCents: number; inventoried: boolean }[];
};

function toFact(n: NoteRow): NoteFact | null {
  if (!isSupplierCreditNoteKind(n.kind)) return null;
  return { ...n, kind: n.kind };
}

/**
 * Hechos del mes: `calendar` es el mes UTC (fechas contables), `business`
 * el rango de días de negocio (instantes).
 */
export async function loadSupplierCreditFacts(
  restaurantId: string,
  calendar: { from: Date; to: Date },
  business: { from: Date; to: Date },
): Promise<SupplierCreditFacts> {
  const cal = { gte: calendar.from, lt: calendar.to };
  const biz = { gte: business.from, lt: business.to };
  const [notes, voids, pp, ep, refunds] = await Promise.all([
    db.supplierCreditNote.findMany({ where: { restaurantId, date: cal }, select: NOTE_SELECT }),
    db.supplierCreditNote.findMany({ where: { restaurantId, status: "voided", voidedAt: biz }, select: NOTE_SELECT }),
    db.purchasePayment.findMany({
      where: { restaurantId, supplierCreditNoteId: { not: null }, paidAt: biz },
      select: { amountCents: true, paidAt: true },
    }),
    db.expensePayment.findMany({
      where: { restaurantId, supplierCreditNoteId: { not: null }, paidAt: biz },
      select: { amountCents: true, paidAt: true },
    }),
    db.supplierCreditNoteRefund.findMany({
      where: { restaurantId, receivedAt: cal },
      select: { amountCents: true, accountCode: true, receivedAt: true },
    }),
  ]);
  return {
    notes: notes.map(toFact).filter((n): n is NoteFact => n != null),
    voids: voids.map(toFact).filter((n): n is NoteFact => n != null && n.voidedAt != null),
    applies: [
      ...pp.map((p) => ({ target: "purchase" as const, amountCents: p.amountCents, at: p.paidAt })),
      ...ep.map((p) => ({ target: "expense" as const, amountCents: p.amountCents, at: p.paidAt })),
    ],
    refunds: refunds.map((r) => ({ amountCents: r.amountCents, accountCode: r.accountCode, at: r.receivedAt })),
  };
}

/** Primer instante con algo que asentar (para la corrida automática). */
export async function firstSupplierCreditActivity(restaurantId: string): Promise<Date | null> {
  const [n, r] = await Promise.all([
    db.supplierCreditNote.aggregate({ where: { restaurantId }, _min: { date: true } }),
    db.supplierCreditNoteRefund.aggregate({ where: { restaurantId }, _min: { receivedAt: true } }),
  ]);
  const dates = [n._min.date, r._min.receivedAt].filter((d): d is Date => d instanceof Date);
  return dates.length ? dates.reduce((a, b) => (b < a ? b : a)) : null;
}
