import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import {
  dateInRange,
  expenseBodySchema,
  recurrenceError,
  supplierOwned,
} from "@/lib/erp/expenseShared";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

const patchSchema = expenseBodySchema.partial();

async function loadOwned(id: string, restaurantId: string) {
  const e = await db.expense.findUnique({ where: { id } });
  if (!e || e.restaurantId !== restaurantId) return null;
  return e;
}

export async function PATCH(
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
  if (!dateInRange(date)) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  if (
    b.supplierId !== undefined &&
    !(await supplierOwned(b.supplierId, ctx.restaurantId))
  ) {
    return NextResponse.json({ error: "supplier_not_found" }, { status: 400 });
  }

  const expense = await db.expense.update({
    where: { id },
    data: {
      ...(b.category !== undefined ? { category: b.category } : {}),
      ...(b.description !== undefined
        ? { description: b.description ?? null }
        : {}),
      ...(b.amountCents !== undefined ? { amountCents: b.amountCents } : {}),
      ...(b.date !== undefined ? { date } : {}),
      ...(b.supplierId !== undefined
        ? { supplierId: b.supplierId ?? null }
        : {}),
      recurring,
      recurringDay: recurring ? recurringDay : null,
    },
    include: { supplier: { select: { id: true, name: true } } },
  });
  return NextResponse.json({ expense });
}

/** Borrar. Plantilla: las copias ya materializadas quedan (templateId → null). */
export async function DELETE(
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
