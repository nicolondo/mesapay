import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";

/**
 * Edit / delete a single menu. We never let the operator delete the
 * last remaining menu — there must always be somewhere for categories
 * to live, and the diner UI assumes ≥1 menu exists. On delete, any
 * categories that pointed at this menu fall back to the first remaining
 * one (Prisma's onDelete: SetNull does step 1, we re-bind in step 2).
 */

const patchSchema = z.object({
  label: z.string().trim().min(1).max(40).optional(),
  description: z.string().trim().max(240).nullable().optional(),
  sortOrder: z.number().int().min(0).max(100).optional(),
});

async function guard(id: string) {
  const session = await auth();
  if (
    !session?.user ||
    (session.user.role !== "operator" &&
      session.user.role !== "platform_admin")
  ) {
    return { error: "unauthorized" as const, status: 401 };
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return { error: "no_restaurant" as const, status: 400 };
  }
  const menu = await db.menu.findUnique({
    where: { id },
    select: { id: true, restaurantId: true },
  });
  if (!menu || menu.restaurantId !== restaurantId) {
    return { error: "not_found" as const, status: 404 };
  }
  return { restaurantId, menuId: menu.id };
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const g = await guard(id);
  if ("error" in g)
    return NextResponse.json({ error: g.error }, { status: g.status });
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  await db.menu.update({ where: { id }, data: parsed.data });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const g = await guard(id);
  if ("error" in g)
    return NextResponse.json({ error: g.error }, { status: g.status });

  // Guardrail: never strand a restaurant with zero menus.
  const remaining = await db.menu.count({
    where: { restaurantId: g.restaurantId, NOT: { id } },
  });
  if (remaining === 0) {
    return NextResponse.json(
      { error: "cannot_delete_last_menu" },
      { status: 400 },
    );
  }

  // Move orphan categories to whatever menu remains first (alphabetical
  // by sortOrder). Without this, the SetNull cascade would leave them
  // unrouted and the diner UI would not show them anywhere.
  const fallback = await db.menu.findFirst({
    where: { restaurantId: g.restaurantId, NOT: { id } },
    orderBy: { sortOrder: "asc" },
    select: { id: true },
  });

  await db.$transaction([
    db.category.updateMany({
      where: { menuId: id },
      data: { menuId: fallback?.id ?? null },
    }),
    db.menu.delete({ where: { id } }),
  ]);
  return NextResponse.json({ ok: true });
}
