import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { monthRange } from "@/lib/erp/accounting";
import {
  dateInRange,
  expenseBodySchema,
  recurrenceError,
  supplierOwned,
} from "@/lib/erp/expenseShared";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

/**
 * Gastos del mes (recurring:false) + TODAS las plantillas (no dependen
 * del mes) + categorías existentes para el datalist (criterio insumos).
 */
export async function GET(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { searchParams } = new URL(req.url);
  const range = monthRange(searchParams.get("month") ?? "");
  if (!range) return NextResponse.json({ error: "invalid" }, { status: 400 });

  const [expenses, templates, categories] = await Promise.all([
    db.expense.findMany({
      where: {
        restaurantId: ctx.restaurantId,
        recurring: false,
        date: { gte: range.from, lt: range.to },
      },
      orderBy: { date: "desc" },
      include: {
        supplier: { select: { id: true, name: true } },
        costCenter: { select: { id: true, name: true } },
      },
    }),
    db.expense.findMany({
      where: { restaurantId: ctx.restaurantId, recurring: true },
      orderBy: { category: "asc" },
      include: {
        supplier: { select: { id: true, name: true } },
        costCenter: { select: { id: true, name: true } },
      },
    }),
    db.expense.groupBy({
      by: ["category"],
      where: { restaurantId: ctx.restaurantId },
      orderBy: { category: "asc" },
    }),
  ]);
  return NextResponse.json({
    expenses,
    templates,
    categories: categories.map((c) => c.category),
  });
}

export async function POST(req: Request) {
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
  if (!dateInRange(date)) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
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
  const session = await auth();
  // Pago de contado: el abono se crea en la MISMA transacción que el gasto.
  // Para el operador es un solo paso; contablemente quedan los dos asientos
  // (gasto contra por-pagar, y por-pagar contra la cuenta elegida).
  const payNow = !b.recurring ? (b.payFromAccountCode ?? null) : null;
  const expense = await db.$transaction(async (tx) => {
    const created = await tx.expense.create({
      data: {
        restaurantId: ctx.restaurantId,
        category: b.category,
        description: b.description ?? null,
        amountCents: b.amountCents,
        date,
        supplierId: b.supplierId ?? null,
        costCenterId: b.costCenterId ?? null,
        accountCode: b.accountCode ?? null,
        dueAt: b.dueAt ? new Date(b.dueAt) : null,
        recurring: b.recurring,
        recurringDay: b.recurring ? b.recurringDay : null,
        paidCents: payNow ? b.amountCents : 0,
        paidAt: payNow ? date : null,
        createdById: session?.user?.id ?? null,
      },
    });
    if (payNow) {
      await tx.expensePayment.create({
        data: {
          restaurantId: ctx.restaurantId,
          expenseId: created.id,
          amountCents: b.amountCents,
          paidAt: date,
          accountCode: payNow,
          createdById: session?.user?.id ?? null,
        },
      });
    }
    return tx.expense.findUnique({
      where: { id: created.id },
      include: {
        supplier: { select: { id: true, name: true } },
        costCenter: { select: { id: true, name: true } },
        payments: { orderBy: { paidAt: "desc" } },
      },
    });
  });
  return NextResponse.json({ expense }, { status: 201 });
}
