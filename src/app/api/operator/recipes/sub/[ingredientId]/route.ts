import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { costRecipeItems, MAX_WASTE_PCT } from "@/lib/erp/recipes";
import { loadCostContext, wouldCreateCycle } from "@/lib/erp/recipeData";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["recipes"];

const itemSchema = z.object({
  ingredientId: z.string().min(1),
  qtyBase: z.number().int().min(1).max(2_000_000_000),
  wastePct: z.number().int().min(0).max(MAX_WASTE_PCT),
});

const putSchema = z.object({
  // Rendimiento del batch en unidad base del insumo output ("rinde 2000 ml").
  outputQtyBase: z.number().int().min(1).max(2_000_000_000),
  items: z.array(itemSchema).min(1).max(100),
  notes: z.string().trim().max(1000).nullable().optional(),
});

/** Upsert de la sub-receta de un insumo elaborado. */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ ingredientId: string }> },
) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { ingredientId } = await params;
  const parsed = putSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const b = parsed.data;

  const ids = b.items.map((i) => i.ingredientId);
  if (new Set(ids).size !== ids.length) {
    return NextResponse.json({ error: "duplicate_ingredient" }, { status: 400 });
  }
  if (ids.includes(ingredientId)) {
    return NextResponse.json(
      { error: "ingredient_in_own_recipe" },
      { status: 400 },
    );
  }

  const output = await db.ingredient.findUnique({
    where: { id: ingredientId },
    select: { id: true, restaurantId: true },
  });
  if (!output || output.restaurantId !== ctx.restaurantId) {
    return NextResponse.json({ error: "ingredient_not_found" }, { status: 404 });
  }

  const ingredients = await db.ingredient.findMany({
    where: { id: { in: ids }, restaurantId: ctx.restaurantId, active: true },
    select: { id: true },
  });
  if (ingredients.length !== ids.length) {
    return NextResponse.json({ error: "ingredient_not_found" }, { status: 400 });
  }

  try {
    const recipe = await db.$transaction(async (tx) => {
      // Ciclo indirecto (A usa B, B usa A) — chequeado dentro de la tx
      // para que dos PUT simultáneos no se cuelen mutuamente.
      if (await wouldCreateCycle(tx, ctx.restaurantId, ingredientId, b.items)) {
        throw new CycleError();
      }
      const r = await tx.recipe.upsert({
        where: { outputIngredientId: ingredientId },
        create: {
          restaurantId: ctx.restaurantId,
          outputIngredientId: ingredientId,
          outputQtyBase: b.outputQtyBase,
          notes: b.notes ?? null,
        },
        update: { outputQtyBase: b.outputQtyBase, notes: b.notes ?? null },
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
          outputQtyBase: true,
          notes: true,
          items: {
            select: { ingredientId: true, qtyBase: true, wastePct: true },
          },
        },
      });
    });

    const { ctx: costCtx } = await loadCostContext(ctx.restaurantId);
    const cost = costRecipeItems(costCtx, recipe.items, new Set([ingredientId]), 1);
    return NextResponse.json({ recipe, cost });
  } catch (err) {
    if (err instanceof CycleError) {
      return NextResponse.json({ error: "recipe_cycle" }, { status: 409 });
    }
    throw err;
  }
}

/** Borra la sub-receta. El insumo sigue existiendo (solo pierde su costo derivado). */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ ingredientId: string }> },
) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { ingredientId } = await params;
  const { count } = await db.recipe.deleteMany({
    where: { outputIngredientId: ingredientId, restaurantId: ctx.restaurantId },
  });
  if (count === 0) {
    return NextResponse.json({ error: "recipe_not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

class CycleError extends Error {}
