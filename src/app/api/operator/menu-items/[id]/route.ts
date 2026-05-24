import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { auth } from "@/auth";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";

const TAGS = ["firma", "popular", "veg", "spicy", "nuevo"] as const;

// Accept both shapes for the option list:
//   "Pollo"                            (legacy, no price delta)
//   { label: "Camarón", priceDeltaCents: 500000 }
// The string form is rewritten to the object form on parse so the rest
// of the code only deals with one type.
const modOptSchema = z.union([
  z
    .string()
    .trim()
    .min(1)
    .max(60)
    .transform((label) => ({ label }) as { label: string; priceDeltaCents?: number }),
  z.object({
    label: z.string().trim().min(1).max(60),
    priceDeltaCents: z.number().int().min(-1_000_000).max(1_000_000).optional(),
  }),
]);

const modifierSchema = z.object({
  id: z.string().trim().min(1).max(40),
  label: z.string().trim().min(1).max(60),
  type: z.enum(["radio", "checkbox"]),
  opts: z.array(modOptSchema).min(1).max(12),
  default: z.string().trim().max(60).optional(),
});

const patchSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  priceCents: z.number().int().min(0).max(100_000_000).optional(),
  description: z.string().trim().max(240).nullable().optional(),
  categoryId: z.string().min(1).optional(),
  available: z.boolean().optional(),
  // Photos always come from our own upload endpoint or from the menu-
  // import downloader, which both write under /uploads/. We refused
  // arbitrary URLs anyway (hotlinking risk + diner privacy), and the
  // old .url() rule incorrectly rejected those local paths — making
  // every edit on a photographed item fail.
  photoUrl: z
    .string()
    .trim()
    .startsWith("/uploads/")
    .nullable()
    .optional(),
  tags: z.array(z.enum(TAGS)).max(5).optional(),
  modifiers: z.array(modifierSchema).max(8).nullable().optional(),
  prepMinutes: z.number().int().min(1).max(120).optional(),
  // Override the category's default station for this specific item.
  // null = inherit from category (the common case). The frontend sends
  // null when the operator picks "Usar la de la categoría".
  prepStation: z.enum(["kitchen", "bar", "counter"]).nullable().optional(),
});

async function guard(id: string) {
  const session = await auth();
  if (
    !session?.user ||
    (session.user.role !== "operator" && session.user.role !== "platform_admin")
  ) {
    return { error: "unauthorized" as const };
  }
  const item = await db.menuItem.findUnique({ where: { id } });
  if (!item) return { error: "not found" as const };
  const activeId = await getActiveRestaurantId();
  if (item.restaurantId !== activeId) {
    return { error: "forbidden" as const };
  }
  return { item, session };
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

  if (parsed.data.categoryId) {
    const cat = await db.category.findUnique({
      where: { id: parsed.data.categoryId },
    });
    if (!cat || cat.restaurantId !== g.item.restaurantId) {
      return NextResponse.json({ error: "invalid category" }, { status: 400 });
    }
  }

  const data: Prisma.MenuItemUncheckedUpdateInput = {};
  if (parsed.data.name !== undefined) data.name = parsed.data.name;
  if (parsed.data.priceCents !== undefined) data.priceCents = parsed.data.priceCents;
  if (parsed.data.description !== undefined) data.description = parsed.data.description;
  if (parsed.data.categoryId !== undefined) data.categoryId = parsed.data.categoryId;
  if (parsed.data.available !== undefined) data.available = parsed.data.available;
  if (parsed.data.photoUrl !== undefined) data.photoUrl = parsed.data.photoUrl;
  if (parsed.data.tags !== undefined) data.tags = parsed.data.tags;
  if (parsed.data.modifiers !== undefined) {
    data.modifiers =
      parsed.data.modifiers === null
        ? Prisma.DbNull
        : (parsed.data.modifiers as unknown as Prisma.InputJsonValue);
  }
  if (parsed.data.prepMinutes !== undefined) data.prepMinutes = parsed.data.prepMinutes;
  if (parsed.data.prepStation !== undefined) data.prepStation = parsed.data.prepStation;

  await db.menuItem.update({ where: { id }, data });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const g = await guard(id);
  if ("error" in g) return NextResponse.json({ error: g.error }, { status: 403 });

  const used = await db.orderItem.count({ where: { menuItemId: id } });
  if (used > 0) {
    // Keep record for historical orders — just mark unavailable.
    await db.menuItem.update({
      where: { id },
      data: { available: false },
    });
    return NextResponse.json({ ok: true, archived: true });
  }
  await db.menuItem.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
