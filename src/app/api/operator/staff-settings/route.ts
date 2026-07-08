import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["staff"];

const SELECT = {
  staffStrictAttendance: true,
  staffHolidayPct: true,
  staffSundayPct: true,
} as const;

export async function GET() {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const settings = await db.restaurant.findUnique({
    where: { id: ctx.restaurantId },
    select: SELECT,
  });
  return NextResponse.json({ settings });
}

const patchSchema = z.object({
  staffStrictAttendance: z.boolean().optional(),
  staffHolidayPct: z.number().int().min(0).max(200).optional(),
  staffSundayPct: z.number().int().min(0).max(200).optional(),
});

/** Ajustes de Horarios (C2 · D4/D5): modo estricto + recargos. */
export async function PATCH(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const settings = await db.restaurant.update({
    where: { id: ctx.restaurantId },
    data: parsed.data,
    select: SELECT,
  });
  return NextResponse.json({ settings });
}
