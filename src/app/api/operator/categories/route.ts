import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { auth } from "@/auth";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { ensureDefaultMenu } from "@/lib/menus";

const createSchema = z.object({
  label: z.string().trim().min(1).max(40),
  kind: z
    .enum(["starter", "main", "side", "drink", "dessert", "other"])
    .optional(),
  // Optional target menu. Falls back to the restaurant's default
  // (Carta) when omitted so the legacy "+ Nueva categoría" button on
  // the menu editor keeps working without changes.
  menuId: z.string().min(1).optional(),
});

function slugify(s: string) {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "cat";
}

export async function POST(req: Request) {
  const session = await auth();
  if (
    !session?.user ||
    (session.user.role !== "operator" && session.user.role !== "platform_admin")
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no restaurant" }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  }

  const base = slugify(parsed.data.label);
  let slug = base;
  let n = 2;
  while (
    await db.category.findUnique({
      where: { restaurantId_slug: { restaurantId, slug } },
    })
  ) {
    slug = `${base}-${n++}`;
  }

  const last = await db.category.findFirst({
    where: { restaurantId },
    orderBy: { sortOrder: "desc" },
  });

  // Resolve target menu. If caller didn't pick one, drop the new
  // category into the restaurant's default menu (Carta). Defensive
  // check: a menuId from the request must belong to this restaurant.
  let menuId = parsed.data.menuId ?? null;
  if (menuId) {
    const menu = await db.menu.findUnique({
      where: { id: menuId },
      select: { restaurantId: true },
    });
    if (!menu || menu.restaurantId !== restaurantId) {
      return NextResponse.json({ error: "invalid_menu" }, { status: 400 });
    }
  } else {
    const fallback = await ensureDefaultMenu(restaurantId);
    menuId = fallback.id;
  }

  const cat = await db.category.create({
    data: {
      restaurantId,
      menuId,
      label: parsed.data.label,
      slug,
      sortOrder: (last?.sortOrder ?? 0) + 10,
      kind: parsed.data.kind ?? "other",
    },
  });

  return NextResponse.json({ id: cat.id });
}
