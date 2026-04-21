import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { auth } from "@/auth";

const patchSchema = z.object({
  label: z.string().trim().min(1).max(40).optional(),
  sortOrder: z.number().int().optional(),
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
  if (
    session.user.role === "operator" &&
    cat.restaurantId !== session.user.restaurantId
  ) {
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
