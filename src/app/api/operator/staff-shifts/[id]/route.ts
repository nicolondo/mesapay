import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { hasOverlap, validShiftRange } from "@/lib/erp/staff";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["staff"];

// Acciones: check_in / check_out punchan con la hora del server;
// clear_punch limpia; edit ajusta rango/nota y/o los tiempos reales a
// mano (llegó 7:12 y nadie marcó — D3).
const patchSchema = z.object({
  action: z.enum(["check_in", "check_out", "clear_punch", "edit"]),
  startMinutes: z.number().int().optional(),
  endMinutes: z.number().int().optional(),
  note: z.string().trim().max(300).nullable().optional(),
  checkInAt: z.string().datetime().nullable().optional(),
  checkOutAt: z.string().datetime().nullable().optional(),
});

async function loadOwned(id: string, restaurantId: string) {
  const s = await db.staffShift.findUnique({ where: { id } });
  if (!s || s.restaurantId !== restaurantId) return null;
  return s;
}

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
  const now = new Date();

  if (b.action === "check_in" || b.action === "check_out" || b.action === "clear_punch") {
    const data =
      b.action === "check_in"
        ? { checkInAt: now }
        : b.action === "check_out"
          ? { checkOutAt: now }
          : { checkInAt: null, checkOutAt: null };
    const shift = await db.staffShift.update({
      where: { id },
      data,
      include: EMPLOYEE_SELECT,
    });
    return NextResponse.json({ shift });
  }

  // edit — validar sobre el estado RESULTANTE.
  const startMinutes = b.startMinutes ?? existing.startMinutes;
  const endMinutes = b.endMinutes ?? existing.endMinutes;
  if (!validShiftRange(startMinutes, endMinutes)) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const checkInAt =
    b.checkInAt !== undefined
      ? b.checkInAt
        ? new Date(b.checkInAt)
        : null
      : existing.checkInAt;
  const checkOutAt =
    b.checkOutAt !== undefined
      ? b.checkOutAt
        ? new Date(b.checkOutAt)
        : null
      : existing.checkOutAt;
  if (checkInAt && checkOutAt && checkOutAt <= checkInAt) {
    return NextResponse.json({ error: "invalid_punch" }, { status: 400 });
  }
  if (b.startMinutes !== undefined || b.endMinutes !== undefined) {
    const sameDay = await db.staffShift.findMany({
      where: { employeeId: existing.employeeId, date: existing.date, id: { not: id } },
      select: { startMinutes: true, endMinutes: true },
    });
    if (hasOverlap(sameDay, { startMinutes, endMinutes })) {
      return NextResponse.json({ error: "shift_overlap" }, { status: 409 });
    }
  }

  const shift = await db.staffShift.update({
    where: { id },
    data: {
      startMinutes,
      endMinutes,
      ...(b.note !== undefined ? { note: b.note ?? null } : {}),
      checkInAt,
      checkOutAt,
    },
    include: EMPLOYEE_SELECT,
  });
  return NextResponse.json({ shift });
}

/** Borrar un turno planeado (artefacto de planeación, no ledger). */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { id } = await params;
  if (!(await loadOwned(id, ctx.restaurantId))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  await db.staffShift.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
