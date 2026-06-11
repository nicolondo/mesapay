import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { auth } from "@/auth";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";

const createSchema = z.object({
  categoryId: z.string().min(1),
  name: z.string().trim().min(1).max(60),
  priceCents: z.number().int().min(0).max(100_000_000),
  description: z.string().trim().max(240).optional(),
  prepMinutes: z.number().min(0.1).max(120).optional(),
});

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

  const category = await db.category.findUnique({
    where: { id: parsed.data.categoryId },
  });
  if (!category || category.restaurantId !== restaurantId) {
    return NextResponse.json({ error: "invalid category" }, { status: 400 });
  }

  const last = await db.menuItem.findFirst({
    where: { categoryId: category.id },
    orderBy: { sortOrder: "desc" },
  });

  const item = await db.menuItem.create({
    data: {
      restaurantId,
      categoryId: category.id,
      name: parsed.data.name,
      priceCents: parsed.data.priceCents,
      description: parsed.data.description || null,
      tags: [],
      available: true,
      sortOrder: (last?.sortOrder ?? 0) + 10,
      prepMinutes: parsed.data.prepMinutes ?? 10,
    },
  });

  return NextResponse.json({ id: item.id });
}
