import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import {
  derivedHourlyCents,
  hasOverlap,
  shiftSurcharge,
  validShiftRange,
  weekRange,
} from "@/lib/erp/staff";
import { holidaysForYear, isSunday } from "@/lib/erp/holidays";
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

  const [shifts, tenant] = await Promise.all([
    db.staffShift.findMany({
      where: { restaurantId: ctx.restaurantId, date: { gte: range.from, lt: range.to } },
      orderBy: [{ date: "asc" }, { startMinutes: "asc" }],
      include: {
        employee: {
          select: { id: true, name: true, position: true, monthlySalaryCents: true, active: true },
        },
      },
    }),
    db.restaurant.findUnique({
      where: { id: ctx.restaurantId },
      select: {
        staffStrictAttendance: true,
        staffHolidayPct: true,
        staffSundayPct: true,
        staffHoursDivisor: true,
      },
    }),
  ]);
  const divisor = tenant?.staffHoursDivisor ?? 240;

  // Festivos del país que caen en la semana (C2 · D5) — la semana puede
  // cruzar de año (29 dic → 4 ene): union de ambos años.
  const holidaySet = new Set([
    ...holidaysForYear(ctx.country, range.from.getUTCFullYear()),
    ...holidaysForYear(ctx.country, range.to.getUTCFullYear()),
  ]);
  const now = new Date();

  const rows = shifts.map((s) => {
    const dayIso = s.date.toISOString().slice(0, 10);
    const holiday = holidaySet.has(dayIso);
    return {
      ...s,
      isHoliday: holiday,
      cost: shiftSurcharge(
        {
          startMinutes: s.startMinutes,
          endMinutes: s.endMinutes,
          checkInAt: s.checkInAt,
          checkOutAt: s.checkOutAt,
          hourlyValueCents: derivedHourlyCents(
            s.employee.monthlySalaryCents,
            divisor,
          ),
        },
        {
          isHoliday: holiday,
          isSunday: isSunday(s.date),
          holidayPct: tenant?.staffHolidayPct ?? 0,
          sundayPct: tenant?.staffSundayPct ?? 0,
          strict: tenant?.staffStrictAttendance ?? false,
          now,
          shiftDate: s.date,
        },
      ),
    };
  });
  const weekIsos: string[] = [];
  for (let i = 0; i < 7; i++) {
    weekIsos.push(
      new Date(range.from.getTime() + i * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10),
    );
  }
  // Vista SEMANAL: el salario es mensual, así que acá NO se muestra una
  // "base" de la semana — solo horas programadas, recargos acumulados y
  // banderas. La base salarial mensual vive en Contabilidad (P&L).
  const totals = {
    shifts: rows.length,
    minutes: rows.reduce((a, r) => a + r.cost.minutes, 0),
    surchargeCents: rows.reduce((a, r) => a + r.cost.surchargeCents, 0),
    missingSalaryShifts: rows.filter((r) => r.cost.missingSalary).length,
    absentShifts: rows.filter((r) => r.cost.source === "absent").length,
  };
  return NextResponse.json({
    shifts: rows,
    totals,
    holidays: weekIsos.filter((d) => holidaySet.has(d)),
    settings: tenant,
  });
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
        select: { id: true, name: true, position: true, monthlySalaryCents: true, active: true },
      },
    },
  });
  return NextResponse.json({ shift }, { status: 201 });
}
