import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { auth } from "@/auth";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";

const patchSchema = z.object({
  label: z.string().trim().min(1).max(40).optional(),
  sortOrder: z.number().int().optional(),
  kind: z
    .enum(["starter", "main", "side", "drink", "dessert", "other"])
    .optional(),
  // Move this category to a different menu (Carta → Vinos, etc).
  // Server checks the menu belongs to the same restaurant.
  menuId: z.string().min(1).optional(),
});

async function guard(id: string) {
  const session = await auth();
  if (
    !session?.user ||
    (session.user.role !== "operator" && session.user.role !== "platform_admin")
  ) {
    return { error: "unauthorized" as const };
  }
  const cat = await db.category.findUnique({ where: { id } });
  if (!cat) return { error: "not found" as const };
  const activeId = await getActiveRestaurantId();
  if (cat.restaurantId !== activeId) {
    return { error: "forbidden" as const };
  }
  return { cat };
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const g = await guard(id);
  if ("error" in g) return NextResponse.json({ error: g.error }, { status: 403 });

  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  // If they're moving the category to a different menu, make sure that
  // menu belongs to the same restaurant — same defensive check we do
  // when changing categoryId on a menu item.
  if (parsed.data.menuId !== undefined) {
    const menu = await db.menu.findUnique({
      where: { id: parsed.data.menuId },
      select: { restaurantId: true },
    });
    if (!menu || menu.restaurantId !== g.cat.restaurantId) {
      return NextResponse.json({ error: "invalid_menu" }, { status: 400 });
    }
  }

  await db.category.update({
    where: { id },
    data: parsed.data,
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const g = await guard(id);
  if ("error" in g) return NextResponse.json({ error: g.error }, { status: 403 });

  const count = await db.menuItem.count({ where: { categoryId: id } });
  if (count > 0) {
    return NextResponse.json(
      { error: "Mueve los platos a otra categoría antes de borrarla." },
      { status: 409 },
    );
  }
  await db.category.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
