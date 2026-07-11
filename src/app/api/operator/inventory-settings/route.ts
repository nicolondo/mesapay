import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["inventory"];

/** Ajustes de inventario: categorías que NO manejan stock + las categorías
 *  existentes del comercio (para elegir). */
export async function GET() {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const [tenant, ingredients] = await Promise.all([
    db.restaurant.findUnique({
      where: { id: ctx.restaurantId },
      select: { inventoryExcludedCategories: true },
    }),
    db.ingredient.findMany({
      where: { restaurantId: ctx.restaurantId },
      select: { category: true },
    }),
  ]);
  const categories = [
    ...new Set(
      ingredients.map((i) => i.category?.trim()).filter((c): c is string => !!c),
    ),
  ].sort();
  return NextResponse.json({
    excludedCategories: tenant?.inventoryExcludedCategories ?? [],
    categories,
  });
}

const patchSchema = z.object({
  inventoryExcludedCategories: z.array(z.string().trim().min(1).max(60)).max(200),
});

export async function PATCH(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  // Dedup + limpio.
  const excluded = [...new Set(parsed.data.inventoryExcludedCategories)];
  await db.restaurant.update({
    where: { id: ctx.restaurantId },
    data: { inventoryExcludedCategories: excluded },
  });
  return NextResponse.json({ excludedCategories: excluded });
}
