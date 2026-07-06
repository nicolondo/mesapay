import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { costRecipeItems, MAX_WASTE_PCT } from "@/lib/erp/recipes";
import { loadCostContext } from "@/lib/erp/recipeData";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["recipes"];

const itemSchema = z.object({
  ingredientId: z.string().min(1),
  qtyBase: z.number().int().min(1).max(2_000_000_000),
  wastePct: z.number().int().min(0).max(MAX_WASTE_PCT),
});

const putSchema = z.object({
  // [] = borrar la receta del plato (spec: items vacío ⇒ delete).
  items: z.array(itemSchema).max(100),
  notes: z.string().trim().max(1000).nullable().optional(),
});

/** Upsert (o borrado con items: []) de la receta de un plato. */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ menuItemId: string }> },
) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { menuItemId } = await params;
  const parsed = putSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const b = parsed.data;

  const ids = b.items.map((i) => i.ingredientId);
  if (new Set(ids).size !== ids.length) {
    return NextResponse.json({ error: "duplicate_ingredient" }, { status: 400 });
  }

  const menuItem = await db.menuItem.findUnique({
    where: { id: menuItemId },
    select: { id: true, restaurantId: true },
  });
  if (!menuItem || menuItem.restaurantId !== ctx.restaurantId) {
    return NextResponse.json({ error: "menu_item_not_found" }, { status: 404 });
  }

  if (b.items.length === 0) {
    await db.recipe.deleteMany({
      where: { menuItemId, restaurantId: ctx.restaurantId },
    });
    return NextResponse.json({ recipe: null });
  }

  const ingredients = await db.ingredient.findMany({
    where: { id: { in: ids }, restaurantId: ctx.restaurantId, active: true },
    select: { id: true },
  });
  if (ingredients.length !== ids.length) {
    return NextResponse.json({ error: "ingredient_not_found" }, { status: 400 });
  }

  // Reemplazo completo (spec D6): borrar líneas y recrear dentro de la tx.
  const recipe = await db.$transaction(async (tx) => {
    const r = await tx.recipe.upsert({
      where: { menuItemId },
      create: {
        restaurantId: ctx.restaurantId,
        menuItemId,
        notes: b.notes ?? null,
      },
      update: { notes: b.notes ?? null },
      select: { id: true },
    });
    await tx.recipeItem.deleteMany({ where: { recipeId: r.id } });
    await tx.recipeItem.createMany({
      data: b.items.map((it) => ({ recipeId: r.id, ...it })),
    });
    return tx.recipe.findUniqueOrThrow({
      where: { id: r.id },
      select: {
        id: true,
        notes: true,
        items: { select: { ingredientId: true, qtyBase: true, wastePct: true } },
      },
    });
  });

  const { ctx: costCtx } = await loadCostContext(ctx.restaurantId);
  const cost = costRecipeItems(costCtx, recipe.items);
  return NextResponse.json({ recipe, cost });
}
