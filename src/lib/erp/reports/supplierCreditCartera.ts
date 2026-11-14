/**
 * Saldos a favor de proveedores en la CARTERA (por pagar). Lo que una nota
 * crédito no alcanzó a cruzar con facturas es un DERECHO del comercio (133005
 * en el libro), no deuda negativa: la cartera lo muestra aparte, por
 * proveedor, y el extracto rotula los cruces como «Nota crédito …».
 *
 * Corte «a una fecha» (`hasta`): notas vigentes fechadas hasta el corte,
 * menos sus cruces y reintegros fechados hasta el corte. Una nota anulada
 * no cuenta (sus cruces ya se deshicieron).
 */
import { db } from "@/lib/db";
import { creditNoteAvailableCents } from "../supplierCreditNotes";
import { cutoffEnd } from "./carteraQueries";

export type SupplierCreditBalance = {
  supplierId: string;
  name: string;
  taxId: string | null;
  notes: number;
  availableCents: number;
};

export async function loadSupplierCreditBalances(
  restaurantId: string,
  hasta: string,
  supplierId?: string,
): Promise<SupplierCreditBalance[]> {
  const to = cutoffEnd(hasta);
  const notes = await db.supplierCreditNote.findMany({
    where: { restaurantId, status: "active", date: { lt: to }, ...(supplierId ? { supplierId } : {}) },
    select: {
      id: true,
      totalCents: true,
      supplier: { select: { id: true, name: true, taxId: true } },
      purchasePayments: { where: { paidAt: { lt: to } }, select: { amountCents: true } },
      expensePayments: { where: { paidAt: { lt: to } }, select: { amountCents: true } },
      refunds: { where: { receivedAt: { lt: to } }, select: { amountCents: true } },
    },
  });
  const sum = (rows: { amountCents: number }[]) => rows.reduce((s, r) => s + r.amountCents, 0);
  // Anticipos: excedentes de comprobantes de egreso, menos lo ya consumido.
  const advances = await db.supplierPayment.findMany({
    where: { restaurantId, status: "active", advanceCents: { gt: 0 }, date: { lt: to }, ...(supplierId ? { supplierId } : {}) },
    select: {
      advanceCents: true,
      supplier: { select: { id: true, name: true, taxId: true } },
      advancePurchaseUses: { where: { paidAt: { lt: to } }, select: { amountCents: true } },
      advanceExpenseUses: { where: { paidAt: { lt: to } }, select: { amountCents: true } },
    },
  });
  const bySupplier = new Map<string, SupplierCreditBalance>();
  for (const a of advances) {
    const available = a.advanceCents - sum(a.advancePurchaseUses) - sum(a.advanceExpenseUses);
    if (available <= 0) continue;
    const g = bySupplier.get(a.supplier.id) ?? { supplierId: a.supplier.id, name: a.supplier.name, taxId: a.supplier.taxId, notes: 0, availableCents: 0 };
    g.notes += 1;
    g.availableCents += available;
    bySupplier.set(a.supplier.id, g);
  }
  for (const n of notes) {
    const available = creditNoteAvailableCents({
      totalCents: n.totalCents,
      appliedCents: sum(n.purchasePayments) + sum(n.expensePayments),
      refundedCents: sum(n.refunds),
    });
    if (available <= 0) continue;
    const g = bySupplier.get(n.supplier.id) ?? {
      supplierId: n.supplier.id,
      name: n.supplier.name,
      taxId: n.supplier.taxId,
      notes: 0,
      availableCents: 0,
    };
    g.notes += 1;
    g.availableCents += available;
    bySupplier.set(n.supplier.id, g);
  }
  return [...bySupplier.values()].sort((a, b) => b.availableCents - a.availableCents || a.name.localeCompare(b.name));
}

export type CrossLabel = { kind: "note" | "advance" | "voucher"; number: string };

/**
 * Abonos de la cartera que no son un pago suelto → cómo rotularlos: cruce de
 * una nota crédito, consumo de un anticipo, o pago de un comprobante (CE).
 */
export async function loadCreditCrossNotes(
  restaurantId: string,
  paymentIds: readonly string[],
): Promise<Map<string, CrossLabel>> {
  if (paymentIds.length === 0) return new Map();
  const ids = [...paymentIds];
  const select = {
    id: true,
    supplierCreditNote: { select: { number: true } },
    supplierAdvance: { select: { number: true } },
    supplierPayment: { select: { number: true } },
  } as const;
  const linked = { OR: [{ supplierCreditNoteId: { not: null } }, { supplierAdvanceId: { not: null } }, { supplierPaymentId: { not: null } }] };
  const [pp, ep] = await Promise.all([
    db.purchasePayment.findMany({ where: { restaurantId, id: { in: ids }, ...linked }, select }),
    db.expensePayment.findMany({ where: { restaurantId, id: { in: ids }, ...linked }, select }),
  ]);
  const out = new Map<string, CrossLabel>();
  for (const p of [...pp, ...ep]) {
    if (p.supplierCreditNote) out.set(p.id, { kind: "note", number: p.supplierCreditNote.number });
    else if (p.supplierAdvance) out.set(p.id, { kind: "advance", number: String(p.supplierAdvance.number).padStart(4, "0") });
    else if (p.supplierPayment) out.set(p.id, { kind: "voucher", number: String(p.supplierPayment.number).padStart(4, "0") });
  }
  return out;
}
