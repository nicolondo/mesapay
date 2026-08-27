import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

/** Centros de costos del comercio (activos primero). */
export async function GET() {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const centers = await db.costCenter.findMany({
    where: { restaurantId: ctx.restaurantId },
    orderBy: [{ active: "desc" }, { name: "asc" }],
  });
  return NextResponse.json({ centers });
}

const createSchema = z.object({ name: z.string().min(2).max(80) });

export async function POST(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const center = await db.costCenter.create({
    data: { restaurantId: ctx.restaurantId, name: parsed.data.name.trim() },
  });
  return NextResponse.json({ ok: true, center }, { status: 201 });
}

const patchSchema = z.object({
  centerId: z.string(),
  active: z.boolean().optional(),
  name: z.string().min(2).max(80).optional(),
});

export async function PATCH(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const b = parsed.data;
  const center = await db.costCenter.findFirst({
    where: { id: b.centerId, restaurantId: ctx.restaurantId },
    select: { id: true },
  });
  if (!center) return NextResponse.json({ error: "not_found" }, { status: 404 });
  await db.costCenter.update({
    where: { id: center.id },
    data: {
      ...(b.active != null && { active: b.active }),
      ...(b.name != null && { name: b.name.trim() }),
    },
  });
  return NextResponse.json({ ok: true });
}
