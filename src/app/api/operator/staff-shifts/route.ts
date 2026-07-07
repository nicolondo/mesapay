import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import {
  hasOverlap,
  shiftCost,
  validShiftRange,
  weekRange,
} from "@/lib/erp/staff";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["staff"];

function parseDay(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  return y >= 2020 && y <= 2100 ? d : null;
}

/**
 * Turnos de una semana (?week=YYYY-MM-DD, DEBE ser lunes) con el costo
 * de cada uno (real si está punchado, planeado si no — D4) y totales.
 */
export async function GET(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { searchParams } = new URL(req.url);
  const range = weekRange(searchParams.get("week") ?? "");
  if (!range) return NextResponse.json({ error: "invalid" }, { status: 400 });

  const shifts = await db.staffShift.findMany({
    where: { restaurantId: ctx.restaurantId, date: { gte: range.from, lt: range.to } },
    orderBy: [{ date: "asc" }, { startMinutes: "asc" }],
    include: {
      employee: {
        select: { id: true, name: true, position: true, hourlyRateCents: true, active: true },
      },
    },
  });

  const rows = shifts.map((s) => ({
    ...s,
    cost: shiftCost({
      startMinutes: s.startMinutes,
      endMinutes: s.endMinutes,
      checkInAt: s.checkInAt,
      checkOutAt: s.checkOutAt,
      hourlyRateCents: s.employee.hourlyRateCents,
    }),
  }));
  const totals = {
    shifts: rows.length,
    minutes: rows.reduce((a, r) => a + r.cost.minutes, 0),
    costCents: rows.reduce((a, r) => a + r.cost.costCents, 0),
    actualCents: rows
      .filter((r) => r.cost.source === "actual")
      .reduce((a, r) => a + r.cost.costCents, 0),
    missingRateShifts: rows.filter((r) => r.cost.missingRate).length,
  };
  return NextResponse.json({ shifts: rows, totals });
}

const createSchema = z.object({
  employeeId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startMinutes: z.number().int(),
  endMinutes: z.number().int(),
  note: z.string().trim().max(300).nullable().optional(),
});

export async function POST(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const b = parsed.data;
  const date = parseDay(b.date);
  if (!date || !validShiftRange(b.startMinutes, b.endMinutes)) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const employee = await db.employee.findUnique({
    where: { id: b.employeeId },
    select: { restaurantId: true, active: true },
  });
  if (!employee || employee.restaurantId !== ctx.restaurantId) {
    return NextResponse.json({ error: "employee_not_found" }, { status: 404 });
  }
  if (!employee.active) {
    return NextResponse.json({ error: "employee_inactive" }, { status: 400 });
  }

  const sameDay = await db.staffShift.findMany({
    where: { employeeId: b.employeeId, date },
    select: { startMinutes: true, endMinutes: true },
  });
  if (hasOverlap(sameDay, b)) {
    return NextResponse.json({ error: "shift_overlap" }, { status: 409 });
  }

  const shift = await db.staffShift.create({
    data: {
      restaurantId: ctx.restaurantId,
      employeeId: b.employeeId,
      date,
      startMinutes: b.startMinutes,
      endMinutes: b.endMinutes,
      note: b.note ?? null,
    },
    include: {
      employee: {
        select: { id: true, name: true, position: true, hourlyRateCents: true, active: true },
      },
    },
  });
  return NextResponse.json({ shift }, { status: 201 });
}
