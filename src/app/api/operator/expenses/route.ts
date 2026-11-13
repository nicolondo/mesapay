import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { bogotaTodayIso } from "@/lib/bogota";
import {
  EXPENSE_INCLUDE,
  dateInRange,
  expenseBodySchema,
  recurrenceError,
  resolveExpenseTaxes,
  supplierOwned,
  taxPayloadFromBody,
} from "@/lib/erp/expenseShared";
import { loadAccountMap } from "@/lib/erp/ledger";
import { loadExpenseList, parseExpenseListParams } from "@/lib/erp/expenseList";
import { ensureExpenseNumbers, numberPendingExpenses } from "@/lib/erp/expenseNumber";
import {
  assertNotDuplicateDocument,
  DuplicateDocumentError,
  duplicateDocumentResponse,
} from "@/lib/erp/duplicateDocuments";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

/**
 * Lista de gastos con búsqueda, filtros y páginas (ver `expenseList.ts`
 * para los parámetros): la página pedida, los totales del conjunto
 * FILTRADO completo y el conteo de cada estado de pago. Además, TODAS las
 * plantillas (no dependen del período) y las categorías existentes (datalist
 * del formulario y filtro «Concepto»). `?month=YYYY-MM` solo sigue siendo
 * «los gastos de ese mes».
 */
async function GETHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const filters = parseExpenseListParams(new URL(req.url).searchParams);
  if (!filters) return NextResponse.json({ error: "invalid" }, { status: 400 });

  // Un gasto que creó la versión anterior durante un despliegue sale ya numerado.
  await ensureExpenseNumbers(ctx.restaurantId);
  const [list, templates, categories] = await Promise.all([
    loadExpenseList(ctx.restaurantId, filters, bogotaTodayIso()),
    db.expense.findMany({
      where: { restaurantId: ctx.restaurantId, recurring: true },
      orderBy: { category: "asc" },
      include: EXPENSE_INCLUDE,
    }),
    db.expense.groupBy({
      by: ["category"],
      where: { restaurantId: ctx.restaurantId },
      orderBy: { category: "asc" },
    }),
  ]);
  return NextResponse.json({
    expenses: list.expenses,
    summary: list.summary,
    counts: list.counts,
    page: list.page,
    pageCount: list.pageCount,
    pageSize: list.pageSize,
    templates,
    categories: categories.map((c) => c.category),
  });
}

/**
 * Crear un gasto (o una plantilla recurrente). Con impuestos, el servidor
 * recalcula todo (expenseTax.ts): `amountCents` = costo del gasto (PYG),
 * `payableCents` = total a pagar (CxP). El IVA descontable sale de la
 * configuración del comercio y queda guardado en el gasto.
 */
async function POSTHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const parsed = expenseBodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const b = { recurring: false, ...parsed.data };
  const recErr = recurrenceError(b);
  if (recErr) return NextResponse.json({ error: recErr }, { status: 400 });
  const date = new Date(b.date);
  const documentDate = b.documentDate ? new Date(b.documentDate) : null;
  if (!dateInRange(date) || (documentDate && !dateInRange(documentDate))) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const payload = taxPayloadFromBody(b);
  if (!payload) return NextResponse.json({ error: "invalid" }, { status: 400 });
  if (!(await supplierOwned(b.supplierId, ctx.restaurantId))) {
    return NextResponse.json({ error: "supplier_not_found" }, { status: 400 });
  }
  if (b.costCenterId) {
    const cc = await db.costCenter.findFirst({
      where: { id: b.costCenterId, restaurantId: ctx.restaurantId },
      select: { id: true },
    });
    if (!cc) {
      return NextResponse.json({ error: "invalid" }, { status: 400 });
    }
  }
  // Pago de contado: el abono se crea en la MISMA transacción que el gasto.
  // Para el operador es un solo paso; contablemente quedan los dos asientos
  // (gasto contra por-pagar, y por-pagar contra la cuenta elegida).
  const payNow = !b.recurring ? (b.payFromAccountCode ?? null) : null;
  if (payNow) {
    // Una cuenta inventada dejaría el asiento de pagos sin generar, en silencio.
    const accounts = await loadAccountMap(ctx.restaurantId);
    if (!accounts.get(payNow)) {
      return NextResponse.json({ error: "account_not_found" }, { status: 400 });
    }
  }
  const tenant = await db.restaurant.findUnique({
    where: { id: ctx.restaurantId },
    select: { purchaseIvaDeductible: true },
  });
  const ivaDeductible = tenant?.purchaseIvaDeductible ?? false;
  const taxes = await resolveExpenseTaxes({
    restaurantId: ctx.restaurantId,
    payload,
    ivaDeductible,
    hasSupplier: Boolean(b.supplierId),
  });
  if (!taxes.ok) return NextResponse.json({ error: taxes.error }, { status: 400 });

  const session = await auth();
  const payable = taxes.fields.payableCents;
  const expense = await db.$transaction(async (tx) => {
    const created = await tx.expense.create({
      data: {
        restaurantId: ctx.restaurantId,
        category: b.category,
        description: b.description ?? null,
        ...taxes.fields,
        documentType: b.documentType ?? "none",
        documentNumber: b.documentNumber || null,
        documentDate,
        attachmentUrl: b.attachmentUrl ?? null,
        date,
        supplierId: b.supplierId ?? null,
        costCenterId: b.costCenterId ?? null,
        accountCode: b.accountCode ?? null,
        dueAt: b.dueAt ? new Date(b.dueAt) : null,
        recurring: b.recurring,
        recurringDay: b.recurring ? b.recurringDay : null,
        paidCents: payNow ? payable : 0,
        paidAt: payNow ? date : null,
        createdById: session?.user?.id ?? null,
        ...(taxes.retentions.length > 0 ? { retentions: { create: taxes.retentions } } : {}),
      },
    });
    // ¿Ese documento del proveedor ya estaba registrado (como gasto o como
    // compra)? Bajo candado y después de escribir: si choca, se deshace.
    // Las plantillas recurrentes no son documentos: no se revisan.
    if (!b.recurring) {
      await assertNotDuplicateDocument(tx, {
        restaurantId: ctx.restaurantId,
        supplierId: b.supplierId ?? null,
        number: b.documentNumber,
        date,
        totalCents: payable,
        exclude: { kind: "expense", id: created.id },
        possibleDuplicate: b.possibleDuplicate,
      });
      // Consecutivo interno (G-0001): en esta misma transacción, bajo el
      // candado del comercio. Va DESPUÉS de la revisión de duplicados (mismo
      // orden de candados en el alta y la edición) y un duplicado deshace
      // todo sin consumir número. Las plantillas no llevan número.
      await numberPendingExpenses(tx, ctx.restaurantId);
    }
    if (payNow) {
      // Se paga el TOTAL A PAGAR (lo retenido no sale de caja: se le debe a la DIAN).
      await tx.expensePayment.create({
        data: {
          restaurantId: ctx.restaurantId,
          expenseId: created.id,
          amountCents: payable,
          paidAt: date,
          accountCode: payNow,
          createdById: session?.user?.id ?? null,
        },
      });
    }
    return tx.expense.findUnique({
      where: { id: created.id },
      include: { ...EXPENSE_INCLUDE, payments: { orderBy: { paidAt: "desc" } } },
    });
  }).catch((err: unknown) => {
    if (err instanceof DuplicateDocumentError) return err;
    throw err;
  });
  if (expense instanceof DuplicateDocumentError) return duplicateDocumentResponse(expense);
  return NextResponse.json({ expense }, { status: 201 });
}

export const GET = secureApi(GETHandler);

export const POST = secureApi(POSTHandler);
