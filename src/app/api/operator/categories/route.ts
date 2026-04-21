import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { auth } from "@/auth";

const createSchema = z.object({
  label: z.string().trim().min(1).max(40),
  kind: z
    .enum(["starter", "main", "side", "drink", "dessert", "other"])
    .optional(),
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
  const restaurantId = session.user.restaurantId;
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

  const cat = await db.category.create({
    data: {
      restaurantId,
      label: parsed.data.label,
      slug,
      sortOrder: (last?.sortOrder ?? 0) + 10,
      kind: parsed.data.kind ?? "other",
    },
  });

  return NextResponse.json({ id: cat.id });
}
