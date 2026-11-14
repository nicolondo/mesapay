// Asientos de los comprobantes de egreso (bloque 10 del motor, posting.ts):
//
//  · supplier_payment       Día de la FECHA del pago: D 220505 proveedores
//                           (lo aplicado a compras) · D 233505 costos y gastos
//                           por pagar (a gastos) · D 133005 anticipo (el
//                           excedente) · C la cuenta de donde salió el dinero.
//  · supplier_payment_void  Día de la anulación: el reverso exacto.
//
// El reparto sale del comprobante (congelado al pagar), no de sus filas:
// así el asiento y su reverso no dependen de que las filas sigan existiendo
// (anular las borra). Los cruces de notas crédito y anticipos hechos en el
// comprobante los asienta el bloque 9 (supplier_credit_apply).
import { db } from "@/lib/db";
import { ENGINE } from "./engineCodes";
import { netPostingLines, reversePostingLines, type PostingLine } from "./supplierCreditNotes";

export type PaymentFact = {
  date: Date;
  voidedAt: Date | null;
  accountCode: string;
  amountCents: number;
  purchaseCents: number;
  expenseCents: number;
  advanceCents: number;
};

export type SupplierPaymentDraft = {
  source: "supplier_payment" | "supplier_payment_void";
  memo: string;
  date: Date;
  day: string;
  lines: PostingLine[];
};

/** Asiento de UN comprobante (cuadra: el reparto suma el dinero pagado). */
export function supplierPaymentLines(p: PaymentFact): PostingLine[] {
  const lines: PostingLine[] = [];
  if (p.purchaseCents > 0) lines.push({ code: ENGINE.PROVEEDORES, debit: p.purchaseCents });
  if (p.expenseCents > 0) lines.push({ code: ENGINE.GASTOS_POR_PAGAR, debit: p.expenseCents });
  if (p.advanceCents > 0) lines.push({ code: ENGINE.SALDO_A_FAVOR_PROVEEDORES, debit: p.advanceCents });
  if (p.amountCents > 0) lines.push({ code: p.accountCode, credit: p.amountCents });
  return lines;
}

function byDay<T>(rows: readonly T[], dayOf: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const d = dayOf(r);
    out.set(d, [...(out.get(d) ?? []), r]);
  }
  return new Map([...out.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

export function buildSupplierPaymentEntries(
  facts: { payments: PaymentFact[]; voids: PaymentFact[] },
  fn: { calendarDay: (d: Date) => string; businessDay: (d: Date) => string; entryDate: (day: string) => Date },
): SupplierPaymentDraft[] {
  const out: SupplierPaymentDraft[] = [];
  for (const [day, rows] of byDay(facts.payments, (p) => fn.calendarDay(p.date))) {
    const lines = netPostingLines(rows.flatMap(supplierPaymentLines));
    if (lines.length) out.push({ source: "supplier_payment", memo: "Comprobantes de egreso del día", date: fn.entryDate(day), day, lines });
  }
  for (const [day, rows] of byDay(facts.voids, (p) => fn.businessDay(p.voidedAt!))) {
    const lines = netPostingLines(rows.flatMap((p) => reversePostingLines(supplierPaymentLines(p))));
    if (lines.length) out.push({ source: "supplier_payment_void", memo: "Anulación de comprobantes de egreso", date: fn.entryDate(day), day, lines });
  }
  return out;
}

const SELECT = {
  date: true,
  voidedAt: true,
  accountCode: true,
  amountCents: true,
  purchaseCents: true,
  expenseCents: true,
  advanceCents: true,
} as const;

/** Comprobantes fechados en el mes (cualquier estado) y anulados en el mes. */
export async function loadSupplierPaymentFacts(
  restaurantId: string,
  calendar: { from: Date; to: Date },
  business: { from: Date; to: Date },
): Promise<{ payments: PaymentFact[]; voids: PaymentFact[] }> {
  const [payments, voids] = await Promise.all([
    db.supplierPayment.findMany({ where: { restaurantId, date: { gte: calendar.from, lt: calendar.to } }, select: SELECT }),
    db.supplierPayment.findMany({
      where: { restaurantId, status: "voided", voidedAt: { gte: business.from, lt: business.to } },
      select: SELECT,
    }),
  ]);
  return { payments, voids: voids.filter((v) => v.voidedAt != null) };
}

/** Primer pago con comprobante (para la corrida automática). */
export async function firstSupplierPaymentActivity(restaurantId: string): Promise<Date | null> {
  const r = await db.supplierPayment.aggregate({ where: { restaurantId }, _min: { date: true } });
  return r._min.date ?? null;
}
