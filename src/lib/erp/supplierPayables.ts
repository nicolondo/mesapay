// Cuentas por pagar de UN proveedor y los cruces que las bajan sin plata
// (saldo a favor de notas crédito). Capa de DATOS: la lógica de orden y
// reparto es pura (supplierCreditAllocation.ts).
//
// Un cruce es un abono más del documento —PurchasePayment / ExpensePayment
// con `supplierCreditNoteId`— y mantiene los mismos caches que los abonos
// en dinero (`paidCents`, `paidAt`): la lista de Compras, «Por pagar», la
// cartera, la exógena y el informe de proveedores lo ven sin cambios.
//
// Concurrencia: todo cruce de un proveedor toma el candado
// `supplier-payables:<comercio>:<proveedor>` y bloquea las filas de los
// documentos (`FOR UPDATE`) antes de leer su saldo; los saldos se mueven con
// incrementos atómicos. Dos operaciones simultáneas sobre el mismo
// proveedor se serializan y la segunda ve el saldo que dejó la primera.
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { ENGINE } from "./engineCodes";
import { expensePayableCents } from "./expenseTax";
import { PURCHASE_LINE_AMOUNTS_SELECT, PURCHASE_ORDER_TAX_SELECT, purchaseOrderTotals } from "./purchaseTax";
import { addDays } from "./reports/cartera";
import { isoDateUtc } from "./reports/period";
import type { PayableDocKind, PayableDocRef } from "./supplierCreditAllocation";

type Client = Prisma.TransactionClient | typeof db;

/** Candado de los cruces y pagos de un proveedor (se suelta con la transacción). */
export async function lockSupplierPayables(tx: Prisma.TransactionClient, restaurantId: string, supplierId: string) {
  const key = `supplier-payables:${restaurantId}:${supplierId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

const PO_PAYABLE_SELECT = {
  id: true,
  number: true,
  createdAt: true,
  receivedAt: true,
  invoiceDueAt: true,
  supplierInvoiceNumber: true,
  paidCents: true,
  ...PURCHASE_ORDER_TAX_SELECT,
  supplier: { select: { paymentTermsDays: true } },
  items: { select: PURCHASE_LINE_AMOUNTS_SELECT },
  movements: {
    where: { kind: "purchase_in" as const },
    select: { createdAt: true },
    orderBy: { createdAt: "asc" as const },
    take: 1,
  },
} satisfies Prisma.PurchaseOrderSelect;

const EXPENSE_PAYABLE_SELECT = {
  id: true,
  date: true,
  dueAt: true,
  category: true,
  description: true,
  documentNumber: true,
  amountCents: true,
  payableCents: true,
  paidCents: true,
} satisfies Prisma.ExpenseSelect;

type PoPayableRow = Prisma.PurchaseOrderGetPayload<{ select: typeof PO_PAYABLE_SELECT }>;
type ExpensePayableRow = Prisma.ExpenseGetPayload<{ select: typeof EXPENSE_PAYABLE_SELECT }>;

/** Compra recibida → documento por pagar (misma fecha y vencimiento que la cartera). */
export function purchasePayableDoc(po: PoPayableRow): PayableDocRef {
  const dateAt = po.receivedAt ?? po.movements[0]?.createdAt ?? po.createdAt;
  const date = isoDateUtc(dateAt);
  const totalCents = purchaseOrderTotals(po, "received").totalCents;
  return {
    kind: "purchase",
    id: po.id,
    number: po.supplierInvoiceNumber,
    purchaseNumber: po.number,
    date,
    dueDate: po.invoiceDueAt ? isoDateUtc(po.invoiceDueAt) : addDays(date, po.supplier.paymentTermsDays ?? 0),
    totalCents,
    outstandingCents: totalCents - po.paidCents,
  };
}

/** Gasto → documento por pagar (lo que se le debe al proveedor: el total a pagar). */
export function expensePayableDoc(e: ExpensePayableRow & { number?: number | null }): PayableDocRef {
  const date = isoDateUtc(e.date);
  const totalCents = expensePayableCents(e);
  return {
    kind: "expense",
    id: e.id,
    number: e.documentNumber,
    purchaseNumber: null,
    expenseNumber: typeof e.number === "number" ? e.number : null,
    concept: e.description || e.category,
    date,
    dueDate: e.dueAt ? isoDateUtc(e.dueAt) : date,
    totalCents,
    outstandingCents: totalCents - e.paidCents,
  };
}

/**
 * Lo que se le debe HOY al proveedor: compras recibidas (total o
 * parcialmente) y gastos no recurrentes con saldo. Con `ids`, sólo esos
 * documentos (con o sin saldo), bloqueados para actualizar si `forUpdate`.
 */
export async function loadSupplierPayables(
  client: Client,
  restaurantId: string,
  supplierId: string,
  opts: { forUpdate?: boolean } = {},
): Promise<PayableDocRef[]> {
  if (opts.forUpdate) {
    const tx = client as Prisma.TransactionClient;
    await tx.$queryRaw`SELECT id FROM "PurchaseOrder" WHERE "restaurantId" = ${restaurantId} AND "supplierId" = ${supplierId} AND status IN ('received', 'partially_received') AND "paidAt" IS NULL FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Expense" WHERE "restaurantId" = ${restaurantId} AND "supplierId" = ${supplierId} AND recurring = false AND "paidAt" IS NULL FOR UPDATE`;
  }
  const [orders, expenses] = await Promise.all([
    client.purchaseOrder.findMany({
      where: {
        restaurantId,
        supplierId,
        status: { in: ["received", "partially_received"] },
        // `paidAt` se fija sólo cuando el saldo llega a 0. Las que tienen INC
        // de cabecera se revisan igual (el cache viejo omitía ese impuesto,
        // mismo criterio que la cartera).
        OR: [{ paidAt: null }, { incCents: { gt: 0 } }],
      },
      select: PO_PAYABLE_SELECT,
      orderBy: { number: "asc" },
    }),
    client.expense.findMany({
      where: { restaurantId, supplierId, recurring: false, paidAt: null },
      select: EXPENSE_PAYABLE_SELECT,
      orderBy: { date: "asc" },
    }),
  ]);
  return [...orders.map(purchasePayableDoc), ...expenses.map(expensePayableDoc)].filter((d) => d.outstandingCents > 0);
}

/**
 * Baja el saldo de UN documento dentro de `tx`: crea el abono y mueve
 * `paidCents`/`paidAt`. Sirve para los tres orígenes:
 *  · cruce de una nota crédito (`creditNoteId`, cuenta 133005),
 *  · consumo de un anticipo (`supplierAdvanceId`, cuenta 133005),
 *  · dinero de un comprobante de egreso (`accountCode` = caja/banco).
 * `supplierPaymentId` liga la fila al comprobante que la creó (anularlo la
 * borra). El caller ya validó el saldo con el candado del proveedor.
 */
export async function applyToDoc(
  tx: Prisma.TransactionClient,
  args: {
    restaurantId: string;
    kind: PayableDocKind;
    id: string;
    amountCents: number;
    at: Date;
    createdById: string | null;
    accountCode?: string;
    creditNoteId?: string | null;
    supplierPaymentId?: string | null;
    supplierAdvanceId?: string | null;
    method?: string | null;
    note?: string | null;
  },
): Promise<{ rowId: string }> {
  const { restaurantId, kind, id, amountCents, at, createdById } = args;
  const links = {
    supplierCreditNoteId: args.creditNoteId ?? null,
    supplierPaymentId: args.supplierPaymentId ?? null,
    supplierAdvanceId: args.supplierAdvanceId ?? null,
  };
  const accountCode = args.accountCode ?? ENGINE.SALDO_A_FAVOR_PROVEEDORES;
  if (kind === "purchase") {
    const row = await tx.purchasePayment.create({
      data: {
        restaurantId,
        purchaseOrderId: id,
        amountCents,
        paidAt: at,
        method: args.method ?? null,
        note: args.note ?? null,
        accountCode,
        ...links,
        createdById,
      },
      select: { id: true },
    });
    const po = await tx.purchaseOrder.update({
      where: { id },
      data: { paidCents: { increment: amountCents } },
      select: { paidCents: true, ...PURCHASE_ORDER_TAX_SELECT, items: { select: PURCHASE_LINE_AMOUNTS_SELECT } },
    });
    if (po.paidCents >= purchaseOrderTotals(po, "received").totalCents) {
      await tx.purchaseOrder.update({ where: { id }, data: { paidAt: at } });
    }
    return { rowId: row.id };
  }
  const row = await tx.expensePayment.create({
    data: {
      restaurantId,
      expenseId: id,
      amountCents,
      paidAt: at,
      accountCode,
      note: args.note ?? null,
      ...links,
      createdById,
    },
    select: { id: true },
  });
  const e = await tx.expense.update({
    where: { id },
    data: { paidCents: { increment: amountCents } },
    select: { paidCents: true, amountCents: true, payableCents: true },
  });
  if (e.paidCents >= expensePayableCents(e)) {
    await tx.expense.update({ where: { id }, data: { paidAt: at } });
  }
  return { rowId: row.id };
}

/** Cruce de una nota crédito con un documento (ver `applyToDoc`). */
export async function applyCreditToDoc(
  tx: Prisma.TransactionClient,
  args: {
    restaurantId: string;
    creditNoteId: string;
    kind: PayableDocKind;
    id: string;
    amountCents: number;
    at: Date;
    createdById: string | null;
    supplierPaymentId?: string | null;
  },
): Promise<void> {
  await applyToDoc(tx, args);
}

/**
 * Deshace TODOS los cruces de una nota (anulación): borra sus abonos y
 * devuelve el saldo a cada documento (quita la marca de pagado si vuelve a
 * deber). Devuelve los documentos tocados.
 */
export async function removeCreditApplications(
  tx: Prisma.TransactionClient,
  restaurantId: string,
  creditNoteId: string,
): Promise<Array<{ kind: PayableDocKind; id: string; amountCents: number }>> {
  return removeDocRows(tx, restaurantId, { supplierCreditNoteId: creditNoteId });
}

/**
 * Borra los abonos que cumplen `link` (los de una nota, o los que creó un
 * comprobante de egreso) y devuelve el saldo a cada documento: quita la
 * marca de pagado si vuelve a deber.
 */
export async function removeDocRows(
  tx: Prisma.TransactionClient,
  restaurantId: string,
  link: { supplierCreditNoteId: string } | { supplierPaymentId: string },
): Promise<Array<{ kind: PayableDocKind; id: string; amountCents: number }>> {
  const [pp, ep] = await Promise.all([
    tx.purchasePayment.findMany({
      where: { restaurantId, ...link },
      select: { id: true, purchaseOrderId: true, amountCents: true },
    }),
    tx.expensePayment.findMany({
      where: { restaurantId, ...link },
      select: { id: true, expenseId: true, amountCents: true },
    }),
  ]);
  const touched: Array<{ kind: PayableDocKind; id: string; amountCents: number }> = [];
  const byPo = new Map<string, number>();
  for (const p of pp) byPo.set(p.purchaseOrderId, (byPo.get(p.purchaseOrderId) ?? 0) + p.amountCents);
  const byExpense = new Map<string, number>();
  for (const p of ep) byExpense.set(p.expenseId, (byExpense.get(p.expenseId) ?? 0) + p.amountCents);

  if (pp.length) await tx.purchasePayment.deleteMany({ where: { id: { in: pp.map((p) => p.id) } } });
  if (ep.length) await tx.expensePayment.deleteMany({ where: { id: { in: ep.map((p) => p.id) } } });

  for (const [id, amount] of byPo) {
    const po = await tx.purchaseOrder.update({
      where: { id },
      data: { paidCents: { decrement: amount } },
      select: { paidCents: true, ...PURCHASE_ORDER_TAX_SELECT, items: { select: PURCHASE_LINE_AMOUNTS_SELECT } },
    });
    if (po.paidCents < purchaseOrderTotals(po, "received").totalCents) {
      await tx.purchaseOrder.update({ where: { id }, data: { paidAt: null } });
    }
    touched.push({ kind: "purchase", id, amountCents: amount });
  }
  for (const [id, amount] of byExpense) {
    const e = await tx.expense.update({
      where: { id },
      data: { paidCents: { decrement: amount } },
      select: { paidCents: true, amountCents: true, payableCents: true },
    });
    if (e.paidCents < expensePayableCents(e)) {
      await tx.expense.update({ where: { id }, data: { paidAt: null } });
    }
    touched.push({ kind: "expense", id, amountCents: amount });
  }
  return touched;
}
