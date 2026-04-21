import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { auth } from "@/auth";

const TAGS = ["firma", "popular", "veg", "spicy", "nuevo"] as const;

const patchSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  priceCents: z.number().int().min(0).max(100_000_000).optional(),
  description: z.string().trim().max(240).nullable().optional(),
  categoryId: z.string().min(1).optional(),
  available: z.boolean().optional(),
  photoUrl: z.string().trim().url().nullable().optional(),
  tags: z.array(z.enum(TAGS)).max(5).optional(),
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
  if (
    session.user.role === "operator" &&
    item.restaurantId !== session.user.restaurantId
  ) {
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

  await db.menuItem.update({ where: { id }, data: parsed.data });
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
