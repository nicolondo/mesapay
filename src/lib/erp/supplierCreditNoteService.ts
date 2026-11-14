// Notas crédito de proveedores — ESCRITURA (registrar, cruzar, reintegrar,
// anular). Cada operación es una transacción con el candado de cuentas por
// pagar del proveedor (supplierPayables.ts). La lógica de montos, cuentas y
// reparto es pura (supplierCreditNotes.ts, supplierCreditAllocation.ts).
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { isMonthClosed } from "./cierre";
import { lockSupplierDocument, sameSupplierIds } from "./duplicateDocuments";
import { normalizeDocumentNumber } from "./documentNumber";
import { loadAccountIndex } from "./ledger";
import { isMoneyAccountCode } from "./paymentAccounts";
import { applyStockMovement } from "./stock";
import {
  accountIsConfigurable,
  creditNoteAmountError,
  creditNoteAvailableCents,
  isValidContraAccountCode,
  returnLineCosts,
  type SupplierCreditNoteKind,
} from "./supplierCreditNotes";
import {
  allocationError,
  payableKey,
  planCreditAllocation,
  type CreditAllocation,
} from "./supplierCreditAllocation";
import {
  applyCreditToDoc,
  loadSupplierPayables,
  lockSupplierPayables,
  removeCreditApplications,
} from "./supplierPayables";

type Tx = Prisma.TransactionClient;
type Client = Tx | typeof db;

export class SupplierCreditError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number = 400,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(code);
    this.name = "SupplierCreditError";
  }
}

/** Fecha elegida (yyyy-mm-dd) → mediodía de Colombia: su día UTC es el elegido. */
export function noonBogota(day: string): Date {
  return new Date(`${day}T17:00:00.000Z`);
}

const TX_OPTS = { maxWait: 10_000, timeout: 30_000 } as const;

/**
 * Último mes cerrado del comercio, SIN crear la configuración (el upsert
 * perezoso de la configuración contable choca consigo mismo con dos
 * operaciones simultáneas del mismo comercio). Sin configuración, nada está
 * cerrado.
 */
export async function readClosedThrough(restaurantId: string): Promise<string | null> {
  const row = await db.accountingConfig.findUnique({ where: { restaurantId }, select: { closedThrough: true } });
  return row?.closedThrough ?? null;
}

async function assertMonthOpen(restaurantId: string, at: Date, code = "month_closed") {
  const cfg = { closedThrough: await readClosedThrough(restaurantId) };
  const month = at.toISOString().slice(0, 7);
  if (isMonthClosed(cfg.closedThrough, month)) {
    throw new SupplierCreditError(code, 409, { closedThrough: cfg.closedThrough });
  }
}

// ─── Saldos ──────────────────────────────────────────────────────────────

export type CreditNoteBalance = {
  id: string;
  number: string;
  date: string;
  kind: string;
  totalCents: number;
  appliedCents: number;
  refundedCents: number;
  availableCents: number;
};

/** Σ cruces y reintegros por nota (para calcular el saldo a favor). */
export async function loadCreditUsage(
  client: Client,
  restaurantId: string,
  noteIds: readonly string[],
): Promise<Map<string, { appliedCents: number; refundedCents: number }>> {
  const out = new Map<string, { appliedCents: number; refundedCents: number }>();
  if (noteIds.length === 0) return out;
  const ids = [...noteIds];
  const [pp, ep, rf] = await Promise.all([
    client.purchasePayment.groupBy({
      by: ["supplierCreditNoteId"],
      where: { restaurantId, supplierCreditNoteId: { in: ids } },
      _sum: { amountCents: true },
    }),
    client.expensePayment.groupBy({
      by: ["supplierCreditNoteId"],
      where: { restaurantId, supplierCreditNoteId: { in: ids } },
      _sum: { amountCents: true },
    }),
    client.supplierCreditNoteRefund.groupBy({
      by: ["creditNoteId"],
      where: { restaurantId, creditNoteId: { in: ids } },
      _sum: { amountCents: true },
    }),
  ]);
  const get = (id: string) => {
    let v = out.get(id);
    if (!v) out.set(id, (v = { appliedCents: 0, refundedCents: 0 }));
    return v;
  };
  for (const r of pp) if (r.supplierCreditNoteId) get(r.supplierCreditNoteId).appliedCents += r._sum.amountCents ?? 0;
  for (const r of ep) if (r.supplierCreditNoteId) get(r.supplierCreditNoteId).appliedCents += r._sum.amountCents ?? 0;
  for (const r of rf) get(r.creditNoteId).refundedCents += r._sum.amountCents ?? 0;
  return out;
}

/** Notas vigentes del proveedor con saldo a favor (las más viejas primero). */
export async function loadSupplierCredits(
  client: Client,
  restaurantId: string,
  supplierId: string,
): Promise<CreditNoteBalance[]> {
  const notes = await client.supplierCreditNote.findMany({
    where: { restaurantId, supplierId, status: "active" },
    select: { id: true, number: true, date: true, kind: true, totalCents: true },
    orderBy: [{ date: "asc" }, { createdAt: "asc" }],
  });
  const usage = await loadCreditUsage(client, restaurantId, notes.map((n) => n.id));
  return notes
    .map((n) => {
      const u = usage.get(n.id) ?? { appliedCents: 0, refundedCents: 0 };
      return {
        id: n.id,
        number: n.number,
        date: n.date.toISOString().slice(0, 10),
        kind: n.kind,
        totalCents: n.totalCents,
        appliedCents: u.appliedCents,
        refundedCents: u.refundedCents,
        availableCents: creditNoteAvailableCents({ ...u, totalCents: n.totalCents }),
      };
    })
    .filter((n) => n.availableCents > 0);
}

// ─── Duplicados ──────────────────────────────────────────────────────────

export type ExistingCreditNoteRef = {
  id: string;
  number: string;
  date: string;
  totalCents: number;
  supplierName: string;
  reason: "number" | "cude";
};

/**
 * ¿La nota ya está registrada? Misma regla que las facturas: el mismo
 * proveedor (o uno con el mismo NIT) y el mismo número normalizado
 * («NC-000123» = «nc 123»), o el mismo CUDE en el comercio. Las anuladas
 * no cuentan (se pueden volver a registrar corregidas).
 */
export async function findDuplicateCreditNote(
  client: Tx,
  args: { restaurantId: string; supplierId: string; number: string; cude?: string | null; excludeId?: string },
): Promise<ExistingCreditNoteRef | null> {
  const select = {
    id: true,
    number: true,
    date: true,
    totalCents: true,
    supplier: { select: { name: true } },
  } as const;
  const ref = (n: { id: string; number: string; date: Date; totalCents: number; supplier: { name: string } }, reason: "number" | "cude") => ({
    id: n.id,
    number: n.number,
    date: n.date.toISOString(),
    totalCents: n.totalCents,
    supplierName: n.supplier.name,
    reason,
  });
  const cude = args.cude?.trim();
  if (cude) {
    const byCude = await client.supplierCreditNote.findFirst({
      where: {
        restaurantId: args.restaurantId,
        status: "active",
        cude: { equals: cude, mode: "insensitive" },
        ...(args.excludeId ? { id: { not: args.excludeId } } : {}),
      },
      select,
    });
    if (byCude) return ref(byCude, "cude");
  }
  const key = normalizeDocumentNumber(args.number);
  if (!key) return null;
  const supplierIds = await sameSupplierIds(client, args.restaurantId, args.supplierId);
  if (supplierIds.length === 0) return null;
  const rows = await client.supplierCreditNote.findMany({
    where: {
      restaurantId: args.restaurantId,
      supplierId: { in: supplierIds },
      status: "active",
      ...(args.excludeId ? { id: { not: args.excludeId } } : {}),
    },
    select,
    orderBy: { createdAt: "asc" },
  });
  const hit = rows.find((n) => normalizeDocumentNumber(n.number) === key);
  return hit ? ref(hit, "number") : null;
}

// ─── Registrar ───────────────────────────────────────────────────────────

export type CreateCreditNoteInput = {
  supplierId: string;
  number: string;
  /** yyyy-mm-dd */
  date: string;
  cude?: string | null;
  kind: SupplierCreditNoteKind;
  agreement?: string | null;
  totalCents: number;
  ivaPct: number;
  ivaCents: number;
  incCents: number;
  accountCode?: string | null;
  note?: string | null;
  attachmentUrl?: string | null;
  extraction?: Prisma.InputJsonValue | null;
  /** Lectura con IA hecha desde «Cargar factura» que resultó ser una nota. */
  invoiceUploadId?: string | null;
  relatedPurchaseIds: string[];
  lines: Array<{ ingredientId: string; purchaseOrderItemId?: string | null; qtyBase: number; valueCents: number }>;
  /** null = plan por defecto (relacionadas primero, luego FIFO). [] = todo a saldo a favor. */
  applications: CreditAllocation[] | null;
};

/**
 * Registra la nota y la aplica de una vez: a las facturas que relaciona y,
 * si sobra (o no relaciona ninguna), FIFO a lo más viejo del proveedor; lo
 * que no se alcanza a cruzar queda como saldo a favor. Una devolución saca
 * sus insumos del kardex al costo que acredita la nota.
 */
export async function createSupplierCreditNote(
  restaurantId: string,
  input: CreateCreditNoteInput,
  userId: string | null,
): Promise<{ id: string }> {
  const date = noonBogota(input.date);
  await assertMonthOpen(restaurantId, date);
  const restaurant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { purchaseIvaDeductible: true },
  });
  const accountCode =
    accountIsConfigurable(input.kind) && input.accountCode?.trim() ? input.accountCode.trim() : null;
  if (accountCode) {
    const index = await loadAccountIndex(restaurantId);
    const acc = index.get(accountCode);
    if (!acc || !acc.postable || acc.active === false || !isValidContraAccountCode(accountCode)) {
      throw new SupplierCreditError("account_invalid");
    }
  }

  return db.$transaction(async (tx) => {
    const supplier = await tx.supplier.findFirst({
      where: { id: input.supplierId, restaurantId },
      select: { id: true },
    });
    if (!supplier) throw new SupplierCreditError("supplier_not_found", 404);

    await lockSupplierDocument(tx, restaurantId, input.number);
    await lockSupplierPayables(tx, restaurantId, supplier.id);
    const dup = await findDuplicateCreditNote(tx, {
      restaurantId,
      supplierId: supplier.id,
      number: input.number,
      cude: input.cude,
    });
    if (dup) throw new SupplierCreditError("duplicate_credit_note", 409, { duplicate: dup });

    // Facturas relacionadas: compras de ESTE proveedor en el comercio.
    const relatedIds = [...new Set(input.relatedPurchaseIds)];
    const related = relatedIds.length
      ? await tx.purchaseOrder.findMany({
          where: { id: { in: relatedIds }, restaurantId, supplierId: supplier.id, status: { not: "canceled" } },
          select: { id: true, items: { select: { id: true, ingredientId: true } } },
        })
      : [];
    if (related.length !== relatedIds.length) throw new SupplierCreditError("purchase_not_found", 404);
    if (input.kind === "return" && related.length === 0) throw new SupplierCreditError("return_needs_invoice");

    // Líneas (sólo devoluciones): insumos del comercio; la línea de compra,
    // si viene, es de una factura relacionada y del mismo insumo.
    const itemOwner = new Map(related.flatMap((po) => po.items.map((it) => [it.id, it.ingredientId] as const)));
    const lineRows = input.kind === "return" ? input.lines : [];
    const ingredients = lineRows.length
      ? await tx.ingredient.findMany({
          where: { restaurantId, id: { in: [...new Set(lineRows.map((l) => l.ingredientId))] } },
          select: { id: true, trackInventory: true },
        })
      : [];
    const tracked = new Map(ingredients.map((i) => [i.id, i.trackInventory !== false]));
    for (const l of lineRows) {
      if (!tracked.has(l.ingredientId)) throw new SupplierCreditError("ingredient_not_found", 404);
      if (!Number.isInteger(l.qtyBase) || l.qtyBase <= 0) throw new SupplierCreditError("line_invalid");
      if (l.purchaseOrderItemId && itemOwner.get(l.purchaseOrderItemId) !== l.ingredientId) {
        throw new SupplierCreditError("line_invalid");
      }
    }
    const baseLines = lineRows.map((l) => ({ ...l, inventoried: tracked.get(l.ingredientId) ?? false }));

    const ivaDeductible = restaurant?.purchaseIvaDeductible ?? false;
    const amounts = {
      kind: input.kind,
      totalCents: input.totalCents,
      ivaCents: input.ivaCents,
      incCents: input.incCents,
      ivaDeductible,
      accountCode,
      lines: baseLines,
    };
    const amountErr = creditNoteAmountError(amounts);
    if (amountErr) throw new SupplierCreditError(amountErr);
    // Costo de cada línea (lo que sale del kardex y acredita 1435), congelado.
    const costs = input.kind === "return" ? returnLineCosts(amounts) : [];
    const lines = baseLines.map((l, i) => ({ ...l, costCents: costs[i] ?? 0 }));

    const note = await tx.supplierCreditNote.create({
      data: {
        restaurantId,
        supplierId: supplier.id,
        number: input.number.trim(),
        date,
        cude: input.cude?.trim() || null,
        kind: input.kind,
        agreement: input.kind === "agreement" ? input.agreement?.trim() || null : null,
        totalCents: input.totalCents,
        ivaPct: input.ivaCents > 0 ? input.ivaPct : 0,
        ivaCents: input.ivaCents,
        ivaDeductible,
        incCents: input.incCents,
        accountCode,
        note: input.note?.trim() || null,
        attachmentUrl: input.attachmentUrl || null,
        ...(input.extraction != null ? { extraction: input.extraction } : {}),
        createdById: userId,
        invoices: { create: related.map((po) => ({ purchaseOrderId: po.id })) },
        lines: {
          create: lines.map((l) => ({
            ingredientId: l.ingredientId,
            purchaseOrderItemId: l.purchaseOrderItemId || null,
            qtyBase: l.qtyBase,
            valueCents: l.valueCents,
            costCents: l.costCents,
            inventoried: l.inventoried,
          })),
        },
      },
      select: { id: true },
    });

    // Devolución: sale del kardex al costo de cada línea (valor + impuesto
    // que fue costo), el mismo que el asiento acredita a 1435.
    if (input.kind === "return") {
      for (const l of lines) {
        if (!l.inventoried) continue;
        await applyStockMovement(
          tx,
          {
            restaurantId,
            ingredientId: l.ingredientId,
            kind: "purchase_return",
            qtyBase: -l.qtyBase,
            totalCostCents: l.costCents,
            supplierCreditNoteId: note.id,
            createdById: userId,
          },
          { allowInactive: true },
        );
      }
    }

    // Cruce inmediato: plan elegido o el de por defecto.
    const pending = await loadSupplierPayables(tx, restaurantId, supplier.id, { forUpdate: true });
    const plan =
      input.applications ??
      planCreditAllocation(
        input.totalCents,
        pending,
        related.map((po) => payableKey({ kind: "purchase", id: po.id })),
      );
    const planErr = allocationError(plan, pending, input.totalCents);
    if (planErr) throw new SupplierCreditError(planErr, 409);
    for (const a of plan) {
      await applyCreditToDoc(tx, {
        restaurantId,
        creditNoteId: note.id,
        kind: a.kind,
        id: a.id,
        amountCents: a.amountCents,
        at: date,
        createdById: userId,
      });
    }

    if (input.invoiceUploadId) {
      await tx.purchaseInvoiceUpload.updateMany({
        where: { id: input.invoiceUploadId, restaurantId, status: "pending" },
        data: { status: "credit_note" },
      });
    }
    return note;
  }, TX_OPTS);
}

// ─── Cruzar saldo a favor después ────────────────────────────────────────

/**
 * Aplica el saldo a favor de UNA nota a documentos del proveedor (plan
 * elegido, o FIFO). Fecha del cruce: `at` (hoy por defecto).
 */
export async function applyCreditNote(
  restaurantId: string,
  noteId: string,
  plan: CreditAllocation[] | null,
  userId: string | null,
  at: Date = new Date(),
): Promise<{ appliedCents: number }> {
  await assertMonthOpen(restaurantId, at);
  return db.$transaction(async (tx) => {
    const note = await tx.supplierCreditNote.findFirst({
      where: { id: noteId, restaurantId },
      select: { id: true, supplierId: true, status: true, totalCents: true },
    });
    if (!note) throw new SupplierCreditError("not_found", 404);
    if (note.status !== "active") throw new SupplierCreditError("voided", 409);
    await lockSupplierPayables(tx, restaurantId, note.supplierId);
    const usage = (await loadCreditUsage(tx, restaurantId, [note.id])).get(note.id);
    const available = creditNoteAvailableCents({ ...(usage ?? { appliedCents: 0, refundedCents: 0 }), totalCents: note.totalCents });
    const pending = await loadSupplierPayables(tx, restaurantId, note.supplierId, { forUpdate: true });
    const chosen = plan ?? planCreditAllocation(available, pending);
    const err = allocationError(chosen, pending, available);
    if (err) throw new SupplierCreditError(err, 409);
    for (const a of chosen) {
      await applyCreditToDoc(tx, { restaurantId, creditNoteId: note.id, ...a, at, createdById: userId });
    }
    return { appliedCents: chosen.reduce((s, a) => s + a.amountCents, 0) };
  }, TX_OPTS);
}

// ─── Reintegro en dinero ─────────────────────────────────────────────────

export async function createCreditRefund(
  restaurantId: string,
  noteId: string,
  input: { amountCents: number; date: string; accountCode: string; note?: string | null },
  userId: string | null,
): Promise<{ id: string }> {
  const receivedAt = noonBogota(input.date);
  await assertMonthOpen(restaurantId, receivedAt);
  const index = await loadAccountIndex(restaurantId);
  const acc = index.get(input.accountCode);
  if (!acc || !acc.postable || acc.active === false || !isMoneyAccountCode(input.accountCode)) {
    throw new SupplierCreditError("account_invalid");
  }
  return db.$transaction(async (tx) => {
    const note = await tx.supplierCreditNote.findFirst({
      where: { id: noteId, restaurantId },
      select: { id: true, supplierId: true, status: true, totalCents: true },
    });
    if (!note) throw new SupplierCreditError("not_found", 404);
    if (note.status !== "active") throw new SupplierCreditError("voided", 409);
    await lockSupplierPayables(tx, restaurantId, note.supplierId);
    const usage = (await loadCreditUsage(tx, restaurantId, [note.id])).get(note.id);
    const available = creditNoteAvailableCents({ ...(usage ?? { appliedCents: 0, refundedCents: 0 }), totalCents: note.totalCents });
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new SupplierCreditError("amount_invalid");
    if (input.amountCents > available) throw new SupplierCreditError("exceeds_available", 409);
    return tx.supplierCreditNoteRefund.create({
      data: {
        restaurantId,
        creditNoteId: note.id,
        amountCents: input.amountCents,
        receivedAt,
        accountCode: input.accountCode,
        note: input.note?.trim() || null,
        createdById: userId,
      },
      select: { id: true },
    });
  }, TX_OPTS);
}

/** Corrige un reintegro mal registrado (sólo con su mes abierto). */
export async function deleteCreditRefund(restaurantId: string, noteId: string, refundId: string): Promise<void> {
  const refund = await db.supplierCreditNoteRefund.findFirst({
    where: { id: refundId, creditNoteId: noteId, restaurantId },
    select: { id: true, receivedAt: true },
  });
  if (!refund) throw new SupplierCreditError("not_found", 404);
  await assertMonthOpen(restaurantId, refund.receivedAt);
  await db.supplierCreditNoteRefund.delete({ where: { id: refund.id } });
}

// ─── Anular ──────────────────────────────────────────────────────────────

/**
 * Anula la nota (nunca se borra): deshace sus cruces —las facturas vuelven
 * a deber lo que la nota les había bajado—, devuelve al kardex lo que salió
 * por la devolución y la marca anulada; el motor asienta el reverso el día
 * de la anulación. No se puede si ya hubo reintegro en dinero (anúlalo
 * primero) o si algún cruce cae en un mes cerrado (su asiento es firme).
 */
export async function voidSupplierCreditNote(
  restaurantId: string,
  noteId: string,
  reason: string | null,
  userId: string | null,
  now: Date = new Date(),
): Promise<void> {
  await assertMonthOpen(restaurantId, now);
  const cfg = { closedThrough: await readClosedThrough(restaurantId) };
  await db.$transaction(async (tx) => {
    const note = await tx.supplierCreditNote.findFirst({
      where: { id: noteId, restaurantId },
      select: { id: true, supplierId: true, status: true },
    });
    if (!note) throw new SupplierCreditError("not_found", 404);
    if (note.status === "voided") throw new SupplierCreditError("already_voided", 409);
    await lockSupplierPayables(tx, restaurantId, note.supplierId);
    const refunds = await tx.supplierCreditNoteRefund.count({ where: { creditNoteId: note.id } });
    if (refunds > 0) throw new SupplierCreditError("has_refunds", 409);
    const [pp, ep] = await Promise.all([
      tx.purchasePayment.findMany({ where: { supplierCreditNoteId: note.id }, select: { paidAt: true } }),
      tx.expensePayment.findMany({ where: { supplierCreditNoteId: note.id }, select: { paidAt: true } }),
    ]);
    if ([...pp, ...ep].some((p) => isMonthClosed(cfg.closedThrough, p.paidAt.toISOString().slice(0, 7)))) {
      throw new SupplierCreditError("applied_in_closed_month", 409);
    }
    await removeCreditApplications(tx, restaurantId, note.id);

    // Devolución: el mismo movimiento con signo contrario y el mismo valor.
    const moves = await tx.stockMovement.findMany({
      where: { restaurantId, supplierCreditNoteId: note.id, kind: "purchase_return", qtyBase: { lt: 0 } },
      select: { ingredientId: true, qtyBase: true, valueCents: true },
    });
    for (const m of moves) {
      await applyStockMovement(
        tx,
        {
          restaurantId,
          ingredientId: m.ingredientId,
          kind: "purchase_return",
          qtyBase: -m.qtyBase,
          totalCostCents: -m.valueCents,
          supplierCreditNoteId: note.id,
          createdById: userId,
        },
        { allowInactive: true, skipUntracked: true },
      );
    }

    await tx.supplierCreditNote.update({
      where: { id: note.id },
      data: { status: "voided", voidedAt: now, voidReason: reason?.trim() || null, voidedById: userId },
    });
  }, TX_OPTS);
}
