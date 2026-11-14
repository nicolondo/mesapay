import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import {
  EXPENSE_INCLUDE,
  bodyTouchesAmounts,
  dateInRange,
  expenseBodySchema,
  recurrenceError,
  resolveExpenseTaxes,
  supplierOwned,
  taxPayloadFromBody,
  type ExpenseRetentionInput,
  type ExpenseTaxPayload,
} from "@/lib/erp/expenseShared";
import { expenseBaseCents, expensePayableCents } from "@/lib/erp/expenseTax";
import { numberPendingExpenses } from "@/lib/erp/expenseNumber";
import type { ModuleSlug } from "@/lib/modules";
import { normalizeDocumentNumber } from "@/lib/erp/documentNumber";
import {
  assertNotDuplicateDocument,
  DuplicateDocumentError,
  duplicateDocumentResponse,
} from "@/lib/erp/duplicateDocuments";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

const patchSchema = expenseBodySchema.partial();

async function loadOwned(id: string, restaurantId: string) {
  const e = await db.expense.findUnique({ where: { id }, include: { retentions: true } });
  if (!e || e.restaurantId !== restaurantId) return null;
  return e;
}

type Owned = NonNullable<Awaited<ReturnType<typeof loadOwned>>>;

/** Las retenciones guardadas, como si las mandara el formulario. */
function storedRetentionInputs(e: Owned): ExpenseRetentionInput[] {
  return e.retentions.map((r) =>
    r.conceptId
      ? { conceptId: r.conceptId, amountCents: r.amountCents }
      : { sourceId: r.id, amountCents: r.amountCents },
  );
}

/**
 * Montos del gasto tras el parche: con `subtotalCents`/`amountCents` manda
 * el cuerpo; si sólo cambia un campo de impuestos (tarifa, INC…), el resto
 * sale de lo guardado.
 */
function mergedPayload(e: Owned, b: Partial<ReturnType<typeof patchSchema.parse>>): ExpenseTaxPayload {
  const fromBody = taxPayloadFromBody(b);
  if (fromBody) {
    return b.retentions === undefined && b.subtotalCents !== undefined
      ? { ...fromBody, retentions: storedRetentionInputs(e) }
      : fromBody;
  }
  return {
    subtotalCents: expenseBaseCents(e) + e.discountCents,
    discountCents: b.discountCents ?? e.discountCents,
    ivaPct: b.ivaPct ?? e.ivaPct,
    // Cambiar la tarifa sin mandar IVA impreso recalcula el IVA.
    ivaCents: b.ivaCents !== undefined ? b.ivaCents : b.ivaPct !== undefined ? null : e.ivaCents,
    incCents: b.incCents ?? e.incCents,
    retentions: b.retentions ?? storedRetentionInputs(e),
  };
}

/**
 * Un gasto (o plantilla) por id: lo abren los enlaces de los reportes
 * (`?expense=`) aunque no esté en la página visible de la lista.
 */
async function GETHandler(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { id } = await params;
  const expense = await db.expense.findFirst({
    where: { id, restaurantId: ctx.restaurantId },
    include: EXPENSE_INCLUDE,
  });
  if (!expense) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ expense });
}

async function PATCHHandler(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { id } = await params;
  const existing = await loadOwned(id, ctx.restaurantId);
  if (!existing) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const b = parsed.data;

  // Estado resultante (existente + cambios) — recurring ⇔ recurringDay
  // se validan sobre el resultado, no sobre el parche.
  const recurring = b.recurring ?? existing.recurring;
  const recurringDay =
    b.recurringDay !== undefined ? b.recurringDay : existing.recurringDay;
  const recErr = recurrenceError({ recurring, recurringDay });
  if (recErr) return NextResponse.json({ error: recErr }, { status: 400 });

  const date = b.date !== undefined ? new Date(b.date) : existing.date;
  const documentDate =
    b.documentDate !== undefined ? (b.documentDate ? new Date(b.documentDate) : null) : existing.documentDate;
  if (!dateInRange(date) || (documentDate && !dateInRange(documentDate))) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  if (
    b.supplierId !== undefined &&
    !(await supplierOwned(b.supplierId, ctx.restaurantId))
  ) {
    return NextResponse.json({ error: "supplier_not_found" }, { status: 400 });
  }
  if (b.costCenterId != null) {
    const cc = await db.costCenter.findFirst({
      where: { id: b.costCenterId, restaurantId: ctx.restaurantId },
      select: { id: true },
    });
    if (!cc) {
      return NextResponse.json({ error: "invalid" }, { status: 400 });
    }
  }
  const supplierId = b.supplierId !== undefined ? (b.supplierId ?? null) : existing.supplierId;

  // Montos: se recalculan si el parche los toca, y también si cambia el
  // proveedor (con IVA o retenciones el proveedor es obligatorio).
  const touches = bodyTouchesAmounts(b) || b.supplierId !== undefined;
  let amounts: Awaited<ReturnType<typeof resolveExpenseTaxes>> | null = null;
  if (touches) {
    // El IVA descontable es una FOTO de la configuración al registrar el
    // gasto: editarlo no la reescribe. Sólo un gasto que no tenía IVA y
    // ahora lo lleva toma la configuración vigente (no había nada que
    // conservar).
    let ivaDeductible = existing.ivaDeductible;
    if (existing.ivaCents === 0) {
      const tenant = await db.restaurant.findUnique({
        where: { id: ctx.restaurantId },
        select: { purchaseIvaDeductible: true },
      });
      ivaDeductible = tenant?.purchaseIvaDeductible ?? false;
    }
    amounts = await resolveExpenseTaxes({
      restaurantId: ctx.restaurantId,
      payload: mergedPayload(existing, b),
      ivaDeductible,
      hasSupplier: Boolean(supplierId),
      existing: existing.retentions,
    });
    if (!amounts.ok) return NextResponse.json({ error: amounts.error }, { status: 400 });
    // Lo ya abonado no se puede deshacer bajando el total a pagar.
    if (!recurring && amounts.fields.payableCents < existing.paidCents) {
      return NextResponse.json({ error: "below_paid" }, { status: 400 });
    }
  }

  const payable = amounts?.ok ? amounts.fields.payableCents : expensePayableCents(existing);
  const paidAt =
    existing.paidCents > 0 && existing.paidCents >= payable
      ? (existing.paidAt ?? new Date())
      : null;

  // Revisión de documento repetido: el número o el proveedor cambian (editar
  // otra cosa de un gasto viejo repetido no se bloquea), o el cliente pide
  // la advertencia sin número. Las plantillas no son documentos.
  const documentNumber = b.documentNumber !== undefined ? (b.documentNumber || null) : existing.documentNumber;
  const documentChanged =
    normalizeDocumentNumber(documentNumber) !== normalizeDocumentNumber(existing.documentNumber) ||
    supplierId !== existing.supplierId;
  const checkDocument = !recurring && (documentChanged || b.possibleDuplicate === "check");

  const expense = await db.$transaction(async (tx) => {
    if (amounts?.ok) {
      await tx.expenseRetention.deleteMany({ where: { expenseId: id } });
      if (amounts.retentions.length > 0) {
        await tx.expenseRetention.createMany({
          data: amounts.retentions.map((r) => ({ ...r, expenseId: id })),
        });
      }
    }
    const updated = await tx.expense.update({
      where: { id },
      data: {
        ...(b.category !== undefined ? { category: b.category } : {}),
        ...(b.description !== undefined
          ? { description: b.description ?? null }
          : {}),
        ...(amounts?.ok ? { ...amounts.fields, paidAt } : {}),
        ...(b.date !== undefined ? { date } : {}),
        ...(b.documentType !== undefined ? { documentType: b.documentType } : {}),
        ...(b.documentNumber !== undefined ? { documentNumber: b.documentNumber || null } : {}),
        ...(b.documentDate !== undefined ? { documentDate } : {}),
        ...(b.attachmentUrl !== undefined ? { attachmentUrl: b.attachmentUrl ?? null } : {}),
        ...(b.supplierId !== undefined ? { supplierId } : {}),
        ...(b.costCenterId !== undefined
          ? { costCenterId: b.costCenterId ?? null }
          : {}),
        // Antes el parche ignoraba la cuenta y el vencimiento: elegir otra
        // cuenta al editar no hacía nada.
        ...(b.accountCode !== undefined ? { accountCode: b.accountCode ?? null } : {}),
        ...(b.dueAt !== undefined ? { dueAt: b.dueAt ? new Date(b.dueAt) : null } : {}),
        recurring,
        recurringDay: recurring ? recurringDay : null,
      },
      include: EXPENSE_INCLUDE,
    });
    if (checkDocument) {
      await assertNotDuplicateDocument(tx, {
        restaurantId: ctx.restaurantId,
        supplierId,
        number: documentNumber,
        date,
        totalCents: payable,
        exclude: { kind: "expense", id },
        possibleDuplicate: b.possibleDuplicate,
      });
    }
    // Una plantilla que pasa a ser gasto normal recibe su consecutivo
    // (después de la revisión de duplicados: mismo orden de candados que el alta).
    if (!recurring && updated.number == null) {
      const assigned = await numberPendingExpenses(tx, ctx.restaurantId);
      return { ...updated, number: assigned.get(id) ?? null };
    }
    return updated;
  }).catch((err: unknown) => {
    if (err instanceof DuplicateDocumentError) return err;
    throw err;
  });
  if (expense instanceof DuplicateDocumentError) return duplicateDocumentResponse(expense);
  return NextResponse.json({ expense });
}

/** Borrar. Plantilla: las copias ya materializadas quedan (templateId → null). */
async function DELETEHandler(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { id } = await params;
  const existing = await loadOwned(id, ctx.restaurantId);
  if (!existing) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  await db.expense.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}

export const GET = secureApi(GETHandler);

export const PATCH = secureApi(PATCHHandler);

export const DELETE = secureApi(DELETEHandler);
