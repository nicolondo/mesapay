import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["staff"];

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  position: z.string().trim().min(1).max(60),
  hourlyRateCents: z.number().int().min(1).max(2_000_000_000).nullable().optional(),
  userId: z.string().min(1).nullable().optional(),
});

async function userOwned(
  userId: string | null | undefined,
  restaurantId: string,
): Promise<boolean> {
  if (!userId) return true;
  const u = await db.user.findUnique({
    where: { id: userId },
    select: { restaurantId: true },
  });
  return u?.restaurantId === restaurantId;
}

/** Equipo completo (activos primero) + cargos existentes para el datalist. */
export async function GET() {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const employees = await db.employee.findMany({
    where: { restaurantId: ctx.restaurantId },
    orderBy: [{ active: "desc" }, { name: "asc" }],
    include: { user: { select: { id: true, name: true, email: true } } },
  });
  const positions = [...new Set(employees.map((e) => e.position))].sort();
  return NextResponse.json({ employees, positions });
}

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
  if (!(await userOwned(b.userId, ctx.restaurantId))) {
    return NextResponse.json({ error: "user_not_found" }, { status: 400 });
  }
  try {
    const employee = await db.employee.create({
      data: {
        restaurantId: ctx.restaurantId,
        name: b.name,
        position: b.position,
        hourlyRateCents: b.hourlyRateCents ?? null,
        userId: b.userId ?? null,
      },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    return NextResponse.json({ employee }, { status: 201 });
  } catch (err) {
    // @@unique([restaurantId, name]) y userId @unique.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return NextResponse.json({ error: "name_taken" }, { status: 409 });
    }
    throw err;
  }
}
