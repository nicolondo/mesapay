import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { ensureDefaultMenu, slugifyMenu } from "@/lib/menus";

/**
 * Menu list + create endpoints. The list call also runs
 * ensureDefaultMenu() so a restaurant always sees at least the Carta.
 */

const createSchema = z.object({
  label: z.string().trim().min(1).max(40),
  description: z.string().trim().max(240).optional(),
});

export async function GET() {
  const session = await auth();
  if (
    !session?.user ||
    (session.user.role !== "operator" &&
      session.user.role !== "platform_admin")
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }
  await ensureDefaultMenu(restaurantId);
  const menus = await db.menu.findMany({
    where: { restaurantId },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      slug: true,
      label: true,
      description: true,
      sortOrder: true,
      _count: { select: { categories: true } },
    },
  });
  return NextResponse.json({ menus });
}

export async function POST(req: Request) {
  const session = await auth();
  if (
    !session?.user ||
    (session.user.role !== "operator" &&
      session.user.role !== "platform_admin")
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  await ensureDefaultMenu(restaurantId);

  // Slug needs to be unique per restaurant. We derive from the label
  // and append a suffix if the natural slug collides.
  const baseSlug = slugifyMenu(parsed.data.label);
  let slug = baseSlug;
  for (let i = 2; i < 50; i++) {
    const existing = await db.menu.findFirst({
      where: { restaurantId, slug },
      select: { id: true },
    });
    if (!existing) break;
    slug = `${baseSlug}-${i}`;
  }

  const last = await db.menu.findFirst({
    where: { restaurantId },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });
  const menu = await db.menu.create({
    data: {
      restaurantId,
      slug,
      label: parsed.data.label,
      description: parsed.data.description ?? null,
      sortOrder: (last?.sortOrder ?? -1) + 1,
    },
  });
  return NextResponse.json({ menu });
}
