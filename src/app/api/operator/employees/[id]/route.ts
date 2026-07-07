import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["staff"];

const patchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  position: z.string().trim().min(1).max(60).optional(),
  hourlyRateCents: z.number().int().min(1).max(2_000_000_000).nullable().optional(),
  userId: z.string().min(1).nullable().optional(),
  active: z.boolean().optional(),
});

async function loadOwned(id: string, restaurantId: string) {
  const e = await db.employee.findUnique({ where: { id } });
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
  if (!(await loadOwned(id, ctx.restaurantId))) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const b = parsed.data;
  if (b.userId) {
    const u = await db.user.findUnique({
      where: { id: b.userId },
      select: { restaurantId: true },
    });
    if (u?.restaurantId !== ctx.restaurantId) {
      return NextResponse.json({ error: "user_not_found" }, { status: 400 });
    }
  }
  try {
    const employee = await db.employee.update({
      where: { id },
      data: {
        ...(b.name !== undefined ? { name: b.name } : {}),
        ...(b.position !== undefined ? { position: b.position } : {}),
        ...(b.hourlyRateCents !== undefined
          ? { hourlyRateCents: b.hourlyRateCents }
          : {}),
        ...(b.userId !== undefined ? { userId: b.userId } : {}),
        ...(b.active !== undefined ? { active: b.active } : {}),
      },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    return NextResponse.json({ employee });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return NextResponse.json({ error: "name_taken" }, { status: 409 });
    }
    throw err;
  }
}

/** DELETE = soft-delete (active:false) — los turnos históricos quedan. */
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
  await db.employee.update({ where: { id }, data: { active: false } });
  return NextResponse.json({ ok: true });
}
