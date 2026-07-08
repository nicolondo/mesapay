import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import {
  templateShiftsForWeek,
  validShiftRange,
  type WeeklyTemplate,
} from "@/lib/erp/staff";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["staff"];

// El kiosko manda su fecha y minuto LOCAL (misma convención device-date
// del planner C1 — el server no conoce la zona horaria de la tablet).
const schema = z.object({
  employeeId: z.string().min(1),
  kind: z.enum(["in", "out"]),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  nowMinutes: z.number().int().min(0).max(1439),
  photoUrl: z.string().max(500).nullable().optional(),
  method: z.enum(["face", "manual"]),
  confidence: z.number().min(0).max(1).nullable().optional(),
});

function parseDay(isoDay: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDay);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const y = d.getUTCFullYear();
  return Number.isNaN(d.getTime()) || y < 2020 || y > 2100 ? null : d;
}

/**
 * Punch del kiosko (C2 · D1): marca entrada/salida del turno de HOY del
 * empleado. Sin turno planeado, la ENTRADA crea el turno implícito desde
 * la plantilla del día (o now→now+8h sin plantilla). La foto queda de
 * evidencia en el turno.
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
  const b = parsed.data;
  const date = parseDay(b.date);
  if (!date) return NextResponse.json({ error: "invalid" }, { status: 400 });

  const employee = await db.employee.findUnique({
    where: { id: b.employeeId },
    select: {
      id: true,
      restaurantId: true,
      active: true,
      weeklyTemplate: true,
    },
  });
  if (!employee || employee.restaurantId !== ctx.restaurantId) {
    return NextResponse.json({ error: "employee_not_found" }, { status: 404 });
  }
  if (!employee.active) {
    return NextResponse.json({ error: "employee_inactive" }, { status: 400 });
  }

  const now = new Date();
  const shifts = await db.staffShift.findMany({
    where: { employeeId: b.employeeId, date },
    orderBy: { startMinutes: "asc" },
  });

  const EMPLOYEE_SELECT = {
    employee: {
      select: {
        id: true,
        name: true,
        position: true,
        hourlyRateCents: true,
        active: true,
      },
    },
  } as const;

  if (b.kind === "out") {
    const open = shifts.find((s) => s.checkInAt && !s.checkOutAt);
    if (!open) {
      return NextResponse.json({ error: "no_open_shift" }, { status: 409 });
    }
    const shift = await db.staffShift.update({
      where: { id: open.id },
      data: {
        checkOutAt: now,
        checkOutPhotoUrl: b.photoUrl ?? null,
        checkOutMethod: b.method,
      },
      include: EMPLOYEE_SELECT,
    });
    return NextResponse.json({ shift, action: "out" });
  }

  // kind === "in": primer turno del día sin entrada.
  const pending = shifts.find((s) => !s.checkInAt);
  if (pending) {
    const shift = await db.staffShift.update({
      where: { id: pending.id },
      data: {
        checkInAt: now,
        checkInPhotoUrl: b.photoUrl ?? null,
        checkInMethod: b.method,
      },
      include: EMPLOYEE_SELECT,
    });
    return NextResponse.json({ shift, action: "in" });
  }
  if (shifts.length > 0) {
    // Todos los turnos de hoy ya tienen entrada.
    return NextResponse.json({ error: "already_punched" }, { status: 409 });
  }

  // Turno implícito (D1.4): plantilla del día o now → now+8h.
  const weekday = (date.getUTCDay() + 6) % 7; // 0=lunes (eje del planner)
  const template = (employee.weeklyTemplate ?? []) as WeeklyTemplate;
  const fromTemplate = Array.isArray(template)
    ? templateShiftsForWeek(
        template.filter((t) => t?.weekday === weekday),
        // La semana del propio día: weekday ya filtrado, monday = date - weekday.
        new Date(date.getTime() - weekday * 24 * 60 * 60 * 1000),
      )[0]
    : undefined;
  let startMinutes: number;
  let endMinutes: number;
  if (fromTemplate) {
    startMinutes = fromTemplate.startMinutes;
    endMinutes = fromTemplate.endMinutes;
  } else {
    startMinutes = b.nowMinutes;
    endMinutes = b.nowMinutes + 480; // 8 h por defecto, editable después
    if (!validShiftRange(startMinutes, endMinutes)) {
      startMinutes = Math.min(b.nowMinutes, 1439);
      endMinutes = startMinutes + 480;
    }
  }

  const shift = await db.staffShift.create({
    data: {
      restaurantId: ctx.restaurantId,
      employeeId: b.employeeId,
      date,
      startMinutes,
      endMinutes,
      checkInAt: now,
      checkInPhotoUrl: b.photoUrl ?? null,
      checkInMethod: b.method,
    },
    include: EMPLOYEE_SELECT,
  });
  return NextResponse.json({ shift, action: "in", implicit: true });
}
