import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

// El catálogo de insumos es la base de los tres módulos del track A:
// basta con tener UNO activo para gestionarlo.
const GATE: ModuleSlug[] = ["inventory", "purchasing", "recipes"];

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  category: z.string().trim().max(60).nullable().optional(),
  measureKind: z.enum(["mass", "volume", "count"]),
  sku: z.string().trim().max(60).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

export async function GET() {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const ingredients = await db.ingredient.findMany({
    where: { restaurantId: ctx.restaurantId },
    orderBy: [{ active: "desc" }, { name: "asc" }],
    include: { _count: { select: { supplierItems: true } } },
  });
  return NextResponse.json({ ingredients });
}

export async function POST(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const b = parsed.data;
  // Unicidad con error legible antes del constraint (la UI muestra
  // name_taken traducido).
  const dup = await db.ingredient.findUnique({
    where: {
      restaurantId_name: { restaurantId: ctx.restaurantId, name: b.name },
    },
    select: { id: true },
  });
  if (dup) {
    return NextResponse.json({ error: "name_taken" }, { status: 409 });
  }
  const ingredient = await db.ingredient.create({
    data: {
      restaurantId: ctx.restaurantId,
      name: b.name,
      category: b.category || null,
      measureKind: b.measureKind,
      sku: b.sku || null,
      notes: b.notes || null,
    },
  });
  return NextResponse.json({ ingredient }, { status: 201 });
}
