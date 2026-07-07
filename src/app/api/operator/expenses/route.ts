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
      include: { supplier: { select: { id: true, name: true } } },
    }),
    db.expense.findMany({
      where: { restaurantId: ctx.restaurantId, recurring: true },
      orderBy: { category: "asc" },
      include: { supplier: { select: { id: true, name: true } } },
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
  const session = await auth();
  const expense = await db.expense.create({
    data: {
      restaurantId: ctx.restaurantId,
      category: b.category,
      description: b.description ?? null,
      amountCents: b.amountCents,
      date,
      supplierId: b.supplierId ?? null,
      recurring: b.recurring,
      recurringDay: b.recurring ? b.recurringDay : null,
      createdById: session?.user?.id ?? null,
    },
    include: { supplier: { select: { id: true, name: true } } },
  });
  return NextResponse.json({ expense }, { status: 201 });
}
