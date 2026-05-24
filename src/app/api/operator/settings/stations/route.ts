import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";

/**
 * Two distinct patch shapes:
 *  - { hasBar }                                  → restaurant-level toggle
 *  - { categoryId, prepStation }                 → re-route a category
 *
 * The client is allowed to call this multiple times in quick succession
 * (every change calls PATCH); we don't batch — the writes are tiny and
 * the UI gives feedback per row.
 */
const schema = z.union([
  z.object({ hasBar: z.boolean() }),
  z.object({
    categoryId: z.string().min(1),
    prepStation: z.enum(["kitchen", "bar", "counter"]),
  }),
]);

export async function PATCH(req: Request) {
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
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  if ("hasBar" in parsed.data) {
    await db.restaurant.update({
      where: { id: restaurantId },
      data: { hasBar: parsed.data.hasBar },
    });
    return NextResponse.json({ ok: true });
  }

  // Category-level update — scope to the active restaurant so an
  // operator can't reroute another tenant's category by guessing IDs.
  const cat = await db.category.findUnique({
    where: { id: parsed.data.categoryId },
    select: { restaurantId: true },
  });
  if (!cat || cat.restaurantId !== restaurantId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  await db.category.update({
    where: { id: parsed.data.categoryId },
    data: { prepStation: parsed.data.prepStation },
  });
  return NextResponse.json({ ok: true });
}
