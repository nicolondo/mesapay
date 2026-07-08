import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import {
  copyWeekPlan,
  templateShiftsForWeek,
  weekRange,
  type PlanShift,
  type WeeklyTemplate,
} from "@/lib/erp/staff";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["staff"];

const schema = z.object({
  week: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/**
 * "Aplicar plantilla" (C2 · D3): llena la semana con los turnos de
 * plantilla de todos los empleados activos, saltando los que chocan con
 * lo ya planeado. Reusa el motor anti-solape de copyWeekPlan (los
 * candidatos ya vienen con la fecha destino ⇒ from == to).
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
  const range = weekRange(parsed.data.week);
  if (!range) return NextResponse.json({ error: "invalid" }, { status: 400 });

  const [employees, existing] = await Promise.all([
    db.employee.findMany({
      where: {
        restaurantId: ctx.restaurantId,
        active: true,
        weeklyTemplate: { not: null as never },
      },
      select: { id: true, weeklyTemplate: true },
    }),
    db.staffShift.findMany({
      where: {
        restaurantId: ctx.restaurantId,
        date: { gte: range.from, lt: range.to },
      },
      select: {
        employeeId: true,
        date: true,
        startMinutes: true,
        endMinutes: true,
      },
    }),
  ]);

  const candidates: PlanShift[] = [];
  for (const e of employees) {
    const tpl = e.weeklyTemplate as WeeklyTemplate | null;
    if (!Array.isArray(tpl)) continue;
    for (const s of templateShiftsForWeek(tpl, range.from)) {
      candidates.push({ employeeId: e.id, note: null, ...s });
    }
  }
  if (candidates.length > 400) {
    return NextResponse.json({ error: "too_many_shifts" }, { status: 400 });
  }

  const { toCreate, skipped } = copyWeekPlan(
    candidates,
    range.from,
    range.from,
    existing,
  );
  if (toCreate.length > 0) {
    await db.staffShift.createMany({
      data: toCreate.map((s) => ({ ...s, restaurantId: ctx.restaurantId })),
    });
  }
  return NextResponse.json({ created: toCreate.length, skipped });
}
