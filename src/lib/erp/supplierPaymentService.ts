// «Pagar a proveedor» — ESCRITURA de comprobantes de egreso (CE-0001).
// Todo bajo el candado de cuentas por pagar del proveedor (supplierPayables);
// el plan es puro (supplierPaymentPlan.ts) y se RECALCULA aquí con los saldos
// frescos: la vista previa del formulario es la misma función.
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { isMonthClosed } from "./cierre";
import { loadAccountIndex } from "./ledger";
import { isMoneyAccountCode } from "./paymentAccounts";
import { drawFromCredits, payableKey, type PayableDocKind } from "./supplierCreditAllocation";
import { loadSupplierCredits, noonBogota, readClosedThrough, SupplierCreditError } from "./supplierCreditNoteService";
import { applyToDoc, loadSupplierPayables, lockSupplierPayables, removeDocRows } from "./supplierPayables";
import { creditKey, planSupplierPayment, type PaymentCredit, type PaymentCreditSource, type PaymentPlan } from "./supplierPaymentPlan";

type Tx = Prisma.TransactionClient;
type Client = Tx | typeof db;
const TX_OPTS = { maxWait: 10_000, timeout: 30_000 } as const;

/** Anticipos vigentes del proveedor (excedentes de pagos) con saldo. */
export async function loadSupplierAdvances(client: Client, restaurantId: string, supplierId: string): Promise<PaymentCredit[]> {
  const payments = await client.supplierPayment.findMany({
    where: { restaurantId, supplierId, status: "active", advanceCents: { gt: 0 } },
    select: { id: true, number: true, date: true, advanceCents: true },
    orderBy: [{ date: "asc" }, { number: "asc" }],
  });
  if (payments.length === 0) return [];
  const ids = payments.map((p) => p.id);
  const [pp, ep] = await Promise.all([
    client.purchasePayment.groupBy({ by: ["supplierAdvanceId"], where: { restaurantId, supplierAdvanceId: { in: ids } }, _sum: { amountCents: true } }),
    client.expensePayment.groupBy({ by: ["supplierAdvanceId"], where: { restaurantId, supplierAdvanceId: { in: ids } }, _sum: { amountCents: true } }),
  ]);
  const used = new Map<string, number>();
  for (const r of [...pp, ...ep]) if (r.supplierAdvanceId) used.set(r.supplierAdvanceId, (used.get(r.supplierAdvanceId) ?? 0) + (r._sum.amountCents ?? 0));
  return payments
    .map((p) => ({
      source: "advance" as const,
      id: p.id,
      label: String(p.number),
      date: p.date.toISOString().slice(0, 10),
      availableCents: p.advanceCents - (used.get(p.id) ?? 0),
      relatedKeys: [],
    }))
    .filter((c) => c.availableCents > 0);
}

/**
 * Saldos a favor del proveedor que se pueden cruzar al pagar: sus notas
 * crédito con saldo (con las facturas que relacionan) y sus anticipos.
 */
export async function loadPaymentCredits(client: Client, restaurantId: string, supplierId: string): Promise<PaymentCredit[]> {
  const [notes, advances] = await Promise.all([
    loadSupplierCredits(client, restaurantId, supplierId),
    loadSupplierAdvances(client, restaurantId, supplierId),
  ]);
  const links = notes.length
    ? await client.supplierCreditNoteInvoice.findMany({
        where: { creditNoteId: { in: notes.map((n) => n.id) } },
        select: { creditNoteId: true, purchaseOrderId: true },
      })
    : [];
  return [
    ...notes.map((n) => ({
      source: "note" as const,
      id: n.id,
      label: n.number,
      date: n.date,
      availableCents: n.availableCents,
      relatedKeys: links.filter((l) => l.creditNoteId === n.id).map((l) => payableKey({ kind: "purchase", id: l.purchaseOrderId })),
    })),
    ...advances,
  ];
}

/**
 * Uso automático del saldo a favor: aplica a UN documento (una compra
 * recibida o un gasto del proveedor) sus saldos a favor —notas crédito y
 * anticipos—, del más viejo al más nuevo, hasta `amountCents` o el saldo del
 * documento.
 */
export async function applySupplierCreditToDoc(
  restaurantId: string,
  target: { kind: PayableDocKind; id: string; amountCents?: number | null },
  userId: string | null,
  at: Date = new Date(),
): Promise<{ appliedCents: number }> {
  const cfg = { closedThrough: await readClosedThrough(restaurantId) };
  if (isMonthClosed(cfg.closedThrough, at.toISOString().slice(0, 7))) throw new SupplierCreditError("month_closed", 409);
  const owner =
    target.kind === "purchase"
      ? await db.purchaseOrder.findFirst({ where: { id: target.id, restaurantId }, select: { supplierId: true } })
      : await db.expense.findFirst({ where: { id: target.id, restaurantId }, select: { supplierId: true } });
  if (!owner?.supplierId) throw new SupplierCreditError("not_found", 404);
  const supplierId = owner.supplierId;
  return db.$transaction(async (tx) => {
    await lockSupplierPayables(tx, restaurantId, supplierId);
    const pending = await loadSupplierPayables(tx, restaurantId, supplierId, { forUpdate: true });
    const doc = pending.find((d) => d.kind === target.kind && d.id === target.id);
    if (!doc) throw new SupplierCreditError("nothing_pending", 409);
    const want = Math.min(doc.outstandingCents, target.amountCents ?? doc.outstandingCents);
    if (!(want > 0)) throw new SupplierCreditError("amount_invalid");
    const all = await loadPaymentCredits(tx, restaurantId, supplierId);
    const byKey = new Map(all.map((c) => [creditKey(c), c]));
    const credits = all.map((c) => ({ ...c, id: creditKey(c) }));
    const draws = drawFromCredits(credits, want);
    for (const d of draws) {
      const c = byKey.get(d.credit.id)!;
      await applyToDoc(tx, {
        restaurantId,
        kind: doc.kind,
        id: doc.id,
        amountCents: d.amountCents,
        at,
        createdById: userId,
        ...(c.source === "note" ? { creditNoteId: c.id } : { supplierAdvanceId: c.id }),
      });
    }
    return { appliedCents: draws.reduce((s, d) => s + d.amountCents, 0) };
  }, TX_OPTS);
}

/** Siguiente consecutivo CE del comercio (bajo candado de la transacción). */
async function nextVoucherNumber(tx: Tx, restaurantId: string): Promise<number> {
  const key = `supplier-payment-number:${restaurantId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  const last = await tx.supplierPayment.aggregate({ where: { restaurantId }, _max: { number: true } });
  return (last._max.number ?? 0) + 1;
}

export type CreateSupplierPaymentInput = {
  supplierId: string;
  /** yyyy-mm-dd */
  date: string;
  accountCode: string;
  method?: string | null;
  reference?: string | null;
  note?: string | null;
  attachmentUrl?: string | null;
  amountCents: number;
  /** Documentos a pagar, en el orden en que se aplican (`payableKey`). */
  docs: Array<{ kind: PayableDocKind; id: string }>;
  /** Saldos a favor a cruzar primero, en orden. */
  credits: Array<{ source: PaymentCreditSource; id: string }>;
  /** Neto a pagar que vio el operador: si cambió, 409 (alguien más pagó o cruzó). */
  expectedNetCents?: number | null;
};

/**
 * Registra el comprobante: cruza los saldos a favor elegidos, aplica el
 * dinero FIFO y deja el excedente como anticipo (si `allowAdvance`; los
 * abonos a UNA factura desde su detalle no lo permiten).
 */
export async function createSupplierPayment(
  restaurantId: string,
  input: CreateSupplierPaymentInput,
  userId: string | null,
  opts: { allowAdvance?: boolean; anyAccount?: boolean } = {},
): Promise<{ id: string; number: number; plan: PaymentPlan }> {
  const date = noonBogota(input.date);
  const cfg = { closedThrough: await readClosedThrough(restaurantId) };
  if (isMonthClosed(cfg.closedThrough, input.date.slice(0, 7))) throw new SupplierCreditError("month_closed", 409);
  const index = await loadAccountIndex(restaurantId);
  const acc = index.get(input.accountCode);
  // Los abonos de un gasto desde su hoja aceptan cualquier cuenta del plan
  // (como siempre); el resto, sólo cuentas de dinero.
  if (!acc || !acc.postable || acc.active === false || (!opts.anyAccount && !isMoneyAccountCode(input.accountCode))) {
    throw new SupplierCreditError("account_invalid");
  }
  if (!Number.isInteger(input.amountCents) || input.amountCents < 0) throw new SupplierCreditError("amount_invalid");

  return db.$transaction(async (tx) => {
    const supplier = await tx.supplier.findFirst({ where: { id: input.supplierId, restaurantId }, select: { id: true } });
    if (!supplier) throw new SupplierCreditError("supplier_not_found", 404);
    await lockSupplierPayables(tx, restaurantId, supplier.id);

    const pending = await loadSupplierPayables(tx, restaurantId, supplier.id, { forUpdate: true });
    const byKey = new Map(pending.map((d) => [payableKey(d), d]));
    const docs = input.docs.map((d) => byKey.get(payableKey(d)));
    if (docs.some((d) => !d)) throw new SupplierCreditError("plan_changed", 409);
    const allCredits = await loadPaymentCredits(tx, restaurantId, supplier.id);
    const creditByKey = new Map(allCredits.map((c) => [creditKey(c), c]));
    const credits = input.credits.map((c) => creditByKey.get(creditKey(c)));
    if (credits.some((c) => !c)) throw new SupplierCreditError("plan_changed", 409);

    const plan = planSupplierPayment({
      docs: docs as NonNullable<(typeof docs)[number]>[],
      credits: credits as PaymentCredit[],
      amountCents: input.amountCents,
    });
    if (input.expectedNetCents != null && input.expectedNetCents !== plan.totals.netToPayCents) {
      throw new SupplierCreditError("plan_changed", 409);
    }
    if (plan.totals.advanceCents > 0 && !opts.allowAdvance) throw new SupplierCreditError("exceeds_balance", 400);
    if (input.amountCents === 0 && plan.creditUses.length === 0) throw new SupplierCreditError("amount_invalid");

    const moneyTo = (kind: PayableDocKind) =>
      plan.moneyUses.filter((u) => u.kind === kind).reduce((s, u) => s + u.amountCents, 0);
    const number = await nextVoucherNumber(tx, restaurantId);
    const payment = await tx.supplierPayment.create({
      data: {
        restaurantId,
        supplierId: supplier.id,
        number,
        date,
        accountCode: input.accountCode,
        method: input.method?.trim() || null,
        reference: input.reference?.trim() || null,
        note: input.note?.trim() || null,
        attachmentUrl: input.attachmentUrl || null,
        amountCents: input.amountCents,
        purchaseCents: moneyTo("purchase"),
        expenseCents: moneyTo("expense"),
        advanceCents: plan.totals.advanceCents,
        creditAppliedCents: plan.totals.creditsCents,
        createdById: userId,
      },
      select: { id: true, number: true },
    });
    for (const u of plan.creditUses) {
      await applyToDoc(tx, {
        restaurantId,
        kind: u.kind,
        id: u.docId,
        amountCents: u.amountCents,
        at: date,
        createdById: userId,
        supplierPaymentId: payment.id,
        ...(u.source === "note" ? { creditNoteId: u.creditId } : { supplierAdvanceId: u.creditId }),
      });
    }
    for (const u of plan.moneyUses) {
      await applyToDoc(tx, {
        restaurantId,
        kind: u.kind,
        id: u.id,
        amountCents: u.amountCents,
        at: date,
        createdById: userId,
        accountCode: input.accountCode,
        supplierPaymentId: payment.id,
        method: input.method?.trim() || null,
        note: input.reference?.trim() || input.note?.trim() || null,
      });
    }
    return { id: payment.id, number: payment.number, plan };
  }, TX_OPTS);
}

/**
 * Anula el comprobante (no se borra): deshace sus abonos y cruces —las
 * facturas vuelven a deber, las notas y anticipos recuperan su saldo— y el
 * motor asienta el reverso el día de la anulación. No se puede si su
 * anticipo ya lo consumió otra factura, o si algo suyo cae en un mes cerrado.
 */
export async function voidSupplierPayment(
  restaurantId: string,
  paymentId: string,
  reason: string | null,
  userId: string | null,
  now: Date = new Date(),
): Promise<void> {
  const cfg = { closedThrough: await readClosedThrough(restaurantId) };
  if (isMonthClosed(cfg.closedThrough, now.toISOString().slice(0, 7))) throw new SupplierCreditError("month_closed", 409);
  await db.$transaction(async (tx) => {
    const p = await tx.supplierPayment.findFirst({
      where: { id: paymentId, restaurantId },
      select: { id: true, supplierId: true, status: true, date: true },
    });
    if (!p) throw new SupplierCreditError("not_found", 404);
    if (p.status === "voided") throw new SupplierCreditError("already_voided", 409);
    await lockSupplierPayables(tx, restaurantId, p.supplierId);
    const usedElsewhere =
      // Ojo con NULL: `NOT (x = p)` descarta las filas con x NULL (las del uso automático).
      (await tx.purchasePayment.count({
        where: { supplierAdvanceId: p.id, OR: [{ supplierPaymentId: null }, { supplierPaymentId: { not: p.id } }] },
      })) +
      (await tx.expensePayment.count({
        where: { supplierAdvanceId: p.id, OR: [{ supplierPaymentId: null }, { supplierPaymentId: { not: p.id } }] },
      }));
    if (usedElsewhere > 0) throw new SupplierCreditError("advance_used", 409);
    if (isMonthClosed(cfg.closedThrough, p.date.toISOString().slice(0, 7))) {
      // Su asiento y sus cruces son firmes: el reverso no los alcanza.
      throw new SupplierCreditError("applied_in_closed_month", 409);
    }
    await removeDocRows(tx, restaurantId, { supplierPaymentId: p.id });
    await tx.supplierPayment.update({
      where: { id: p.id },
      data: { status: "voided", voidedAt: now, voidReason: reason?.trim() || null, voidedById: userId },
    });
  }, TX_OPTS);
}
