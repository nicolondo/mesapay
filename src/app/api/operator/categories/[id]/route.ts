import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
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
  // Subcategoría: id de la categoría padre (top-level) o null para desanidar.
  // Reglas (un solo nivel): el padre no puede ser hijo de otra, ni ser uno
  // mismo, y la categoría que se vuelve hija no puede tener hijas propias.
  parentId: z.string().min(1).nullable().optional(),
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

  const data: Prisma.CategoryUncheckedUpdateInput = {};
  if (parsed.data.label !== undefined) data.label = parsed.data.label;
  if (parsed.data.sortOrder !== undefined) data.sortOrder = parsed.data.sortOrder;
  if (parsed.data.kind !== undefined) data.kind = parsed.data.kind;

  // --- Subcategoría (parentId) ---
  let forcedMenuId: string | null | undefined;
  if (parsed.data.parentId !== undefined) {
    if (parsed.data.parentId === null) {
      data.parentId = null;
    } else {
      if (parsed.data.parentId === id) {
        return NextResponse.json({ error: "invalid_parent" }, { status: 400 });
      }
      // Un solo nivel: la categoría que se vuelve hija no puede tener hijas.
      const childCount = await db.category.count({ where: { parentId: id } });
      if (childCount > 0) {
        return NextResponse.json({ error: "has_children" }, { status: 400 });
      }
      const parent = await db.category.findUnique({
        where: { id: parsed.data.parentId },
        select: { restaurantId: true, parentId: true, menuId: true },
      });
      if (!parent || parent.restaurantId !== g.cat.restaurantId) {
        return NextResponse.json({ error: "invalid_parent" }, { status: 400 });
      }
      // Un solo nivel: el padre no puede ser a su vez hijo de otra.
      if (parent.parentId) {
        return NextResponse.json({ error: "parent_is_child" }, { status: 400 });
      }
      data.parentId = parsed.data.parentId;
      // La subcategoría hereda el menú del padre (no pueden quedar en menús
      // distintos).
      forcedMenuId = parent.menuId;
      data.menuId = parent.menuId;
    }
  }

  // --- Mover de menú (menuId) ---
  // Si arriba ya forzamos el menú (al anidar), no volvemos a procesarlo.
  if (parsed.data.menuId !== undefined && forcedMenuId === undefined) {
    const menu = await db.menu.findUnique({
      where: { id: parsed.data.menuId },
      select: { restaurantId: true },
    });
    if (!menu || menu.restaurantId !== g.cat.restaurantId) {
      return NextResponse.json({ error: "invalid_menu" }, { status: 400 });
    }
    // Una subcategoría no se mueve de menú por su cuenta: sigue al padre.
    if (g.cat.parentId && parsed.data.parentId === undefined) {
      return NextResponse.json({ error: "child_menu_locked" }, { status: 400 });
    }
    data.menuId = parsed.data.menuId;
  }

  // Si esta categoría es PADRE y cambia de menú, sus hijas se mueven con ella
  // (en una transacción) para no dejarlas huérfanas en otro menú.
  const movingMenu = data.menuId !== undefined;
  if (movingMenu) {
    await db.$transaction([
      db.category.update({ where: { id }, data }),
      db.category.updateMany({
        where: { parentId: id },
        data: { menuId: data.menuId as string | null },
      }),
    ]);
  } else {
    await db.category.update({ where: { id }, data });
  }
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
  // Si era una categoría padre, sus subcategorías quedan en el nivel superior
  // (el FK parentId está con onDelete: SetNull). No se borran.
  await db.category.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
