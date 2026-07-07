import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { copyWeekPlan, weekRange } from "@/lib/erp/staff";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["staff"];

const schema = z.object({
  fromWeek: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  toWeek: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/**
 * "Copiar semana": replica los turnos de fromWeek a la misma posición
 * relativa de toWeek, saltando choques con lo ya planeado. Empleados
 * inactivados desde entonces no se copian.
 */
export async function POST(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const from = weekRange(parsed.data.fromWeek);
  const to = weekRange(parsed.data.toWeek);
  if (!from || !to || from.from.getTime() === to.from.getTime()) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const [fromShifts, existingTo] = await Promise.all([
    db.staffShift.findMany({
      where: {
        restaurantId: ctx.restaurantId,
        date: { gte: from.from, lt: from.to },
        employee: { active: true },
      },
      select: {
        employeeId: true,
        date: true,
        startMinutes: true,
        endMinutes: true,
        note: true,
      },
    }),
    db.staffShift.findMany({
      where: { restaurantId: ctx.restaurantId, date: { gte: to.from, lt: to.to } },
      select: { employeeId: true, date: true, startMinutes: true, endMinutes: true },
    }),
  ]);
  if (fromShifts.length > 200) {
    return NextResponse.json({ error: "too_many_shifts" }, { status: 400 });
  }

  const { toCreate, skipped } = copyWeekPlan(
    fromShifts,
    from.from,
    to.from,
    existingTo,
  );
  if (toCreate.length > 0) {
    await db.staffShift.createMany({
      data: toCreate.map((s) => ({ ...s, restaurantId: ctx.restaurantId })),
    });
  }
  return NextResponse.json({ copied: toCreate.length, skipped });
}
