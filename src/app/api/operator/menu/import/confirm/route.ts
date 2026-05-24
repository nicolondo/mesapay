import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";

const itemSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable(),
  priceCents: z.number().int().min(0).max(100_000_000),
  // Either an id of an existing category or a slug of a new one (we
  // create it before the item if the slug doesn't match an existing id).
  categoryRef: z.union([
    z.object({ kind: z.literal("existing"), categoryId: z.string().min(1) }),
    z.object({
      kind: z.literal("new"),
      slug: z.string().trim().min(1).max(60),
      label: z.string().trim().min(1).max(80),
      categoryKind: z.enum([
        "starter",
        "main",
        "side",
        "drink",
        "dessert",
        "other",
      ]),
    }),
  ]),
  tags: z.array(z.string()).default([]),
});

const schema = z.object({
  items: z.array(itemSchema).min(1).max(200),
});

/**
 * Persist a reviewed menu. We process inside a single transaction so the
 * operator either gets all items or none — partial imports would leave
 * a confusing half-state.
 *
 * For new categories: dedupe by slug within this batch (multiple items
 * pointing to the same new slug share one new Category row).
 */
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
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  // Collect distinct "new category" slugs so we create each only once.
  const newCategoriesBySlug = new Map<
    string,
    { label: string; kind: "starter" | "main" | "side" | "drink" | "dessert" | "other" }
  >();
  for (const it of parsed.data.items) {
    if (it.categoryRef.kind === "new") {
      newCategoriesBySlug.set(it.categoryRef.slug, {
        label: it.categoryRef.label,
        kind: it.categoryRef.categoryKind,
      });
    }
  }

  // For sortOrder of new categories we pick up where existing leave off.
  const lastCategory = await db.category.findFirst({
    where: { restaurantId },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });
  let nextSort = (lastCategory?.sortOrder ?? -1) + 1;

  const result = await db.$transaction(async (tx) => {
    const slugToId = new Map<string, string>();

    // Look up existing categories already on this restaurant by slug so
    // we can reuse them if a "new" entry collides.
    const existing = await tx.category.findMany({
      where: { restaurantId },
      select: { id: true, slug: true },
    });
    for (const c of existing) slugToId.set(c.slug, c.id);

    for (const [slug, info] of newCategoriesBySlug) {
      if (slugToId.has(slug)) continue;
      const created = await tx.category.create({
        data: {
          restaurantId,
          slug,
          label: info.label,
          kind: info.kind,
          sortOrder: nextSort++,
        },
      });
      slugToId.set(slug, created.id);
    }

    let nextItemSort = (
      await tx.menuItem.findFirst({
        where: { restaurantId },
        orderBy: { sortOrder: "desc" },
        select: { sortOrder: true },
      })
    )?.sortOrder ?? -1;

    const createdItems: { id: string; name: string }[] = [];
    for (const it of parsed.data.items) {
      let categoryId: string;
      if (it.categoryRef.kind === "existing") {
        categoryId = it.categoryRef.categoryId;
      } else {
        const id = slugToId.get(it.categoryRef.slug);
        if (!id) throw new Error("category not created");
        categoryId = id;
      }
      const created = await tx.menuItem.create({
        data: {
          restaurantId,
          categoryId,
          name: it.name,
          description: it.description ?? null,
          priceCents: it.priceCents,
          tags: it.tags,
          sortOrder: ++nextItemSort,
          available: true,
        },
        select: { id: true, name: true },
      });
      createdItems.push(created);
    }
    return { items: createdItems };
  });

  return NextResponse.json({
    ok: true,
    createdCount: result.items.length,
    items: result.items,
  });
}
