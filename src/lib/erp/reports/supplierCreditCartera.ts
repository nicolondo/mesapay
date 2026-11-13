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
  const bySupplier = new Map<string, SupplierCreditBalance>();
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

/** Abonos que son cruces con una nota crédito → número de la nota (para rotularlos). */
export async function loadCreditCrossNotes(
  restaurantId: string,
  paymentIds: readonly string[],
): Promise<Map<string, string>> {
  if (paymentIds.length === 0) return new Map();
  const ids = [...paymentIds];
  const [pp, ep] = await Promise.all([
    db.purchasePayment.findMany({
      where: { restaurantId, id: { in: ids }, supplierCreditNoteId: { not: null } },
      select: { id: true, supplierCreditNote: { select: { number: true } } },
    }),
    db.expensePayment.findMany({
      where: { restaurantId, id: { in: ids }, supplierCreditNoteId: { not: null } },
      select: { id: true, supplierCreditNote: { select: { number: true } } },
    }),
  ]);
  const out = new Map<string, string>();
  for (const p of [...pp, ...ep]) if (p.supplierCreditNote) out.set(p.id, p.supplierCreditNote.number);
  return out;
}
