import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import {
  MAX_MENU_TAGS,
  SLUG_REGEX,
  getRestaurantMenuTags,
} from "@/lib/menuTags";

export const dynamic = "force-dynamic";

const tagSchema = z.object({
  slug: z.string().regex(SLUG_REGEX, "slug inválido"),
  label: z.string().min(1).max(40),
  emoji: z.string().max(8).optional(),
});

const putBody = z.object({
  // Whole-list replace — simpler than per-tag CRUD and matches how the
  // settings page batches edits with a single Save button.
  tags: z.array(tagSchema).max(MAX_MENU_TAGS),
});

function guard(role?: string) {
  return role === "operator" || role === "platform_admin";
}

export async function GET() {
  const session = await auth();
  if (!guard(session?.user?.role)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no restaurant" }, { status: 400 });
  }
  const tags = await getRestaurantMenuTags(restaurantId);
  return NextResponse.json({ tags });
}

export async function PUT(req: Request) {
  const session = await auth();
  if (!guard(session?.user?.role)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no restaurant" }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  const parsed = putBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid" },
      { status: 400 },
    );
  }

  // Unique slugs across the list — duplicates would render twice in the
  // editor and break the slug → label lookup on the diner side.
  const slugs = new Set<string>();
  for (const t of parsed.data.tags) {
    if (slugs.has(t.slug)) {
      return NextResponse.json(
        { error: `slug duplicado: ${t.slug}` },
        { status: 400 },
      );
    }
    slugs.add(t.slug);
  }

  await db.restaurant.update({
    where: { id: restaurantId },
    data: {
      menuTags: parsed.data.tags as unknown as object,
    },
  });

  return NextResponse.json({ ok: true, tags: parsed.data.tags });
}
