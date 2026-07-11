import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { costRecipeItems, MAX_WASTE_PCT } from "@/lib/erp/recipes";
import { loadCostContext } from "@/lib/erp/recipeData";
import { normalizeModifiers } from "@/lib/modifiers";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["recipes"];

const itemSchema = z.object({
  ingredientId: z.string().min(1),
  qtyBase: z.number().int().min(1).max(2_000_000_000),
  wastePct: z.number().int().min(0).max(MAX_WASTE_PCT),
});

// Delta de insumo por opción de modificador: qtyBase con SIGNO (≠ 0).
const modifierItemSchema = z.object({
  modifierId: z.string().trim().min(1).max(40),
  optLabel: z.string().trim().min(1).max(60),
  ingredientId: z.string().min(1),
  qtyBase: z
    .number()
    .int()
    .min(-2_000_000_000)
    .max(2_000_000_000)
    .refine((v) => v !== 0, { message: "nonzero" }),
  wastePct: z.number().int().min(0).max(MAX_WASTE_PCT),
});

const putSchema = z.object({
  // [] = borrar la receta del plato (spec: items vacío ⇒ delete).
  items: z.array(itemSchema).max(100),
  // Deltas de insumo por opción de modificador (A4.mods). Requiere receta base.
  modifierItems: z.array(modifierItemSchema).max(300).optional().default([]),
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

  // Deltas de modificador: únicos por (grupo, opción, insumo).
  const modKeys = b.modifierItems.map(
    (m) => JSON.stringify([m.modifierId, m.optLabel, m.ingredientId]),
  );
  if (new Set(modKeys).size !== modKeys.length) {
    return NextResponse.json({ error: "duplicate_modifier_item" }, { status: 400 });
  }

  const menuItem = await db.menuItem.findUnique({
    where: { id: menuItemId },
    select: { id: true, restaurantId: true, modifiers: true },
  });
  if (!menuItem || menuItem.restaurantId !== ctx.restaurantId) {
    return NextResponse.json({ error: "menu_item_not_found" }, { status: 404 });
  }

  if (b.items.length === 0) {
    // Sin receta base no hay dónde colgar los deltas: se borra todo (cascade).
    await db.recipe.deleteMany({
      where: { menuItemId, restaurantId: ctx.restaurantId },
    });
    return NextResponse.json({ recipe: null });
  }

  // Cada delta debe apuntar a una opción de modificador que EXISTE hoy en el
  // plato (evita deltas huérfanos que nunca emparejarían una selección).
  if (b.modifierItems.length > 0) {
    const validOpts = new Set<string>();
    for (const m of normalizeModifiers(menuItem.modifiers)) {
      for (const o of m.opts) validOpts.add(JSON.stringify([m.id, o.label]));
    }
    const bad = b.modifierItems.some(
      (m) => !validOpts.has(JSON.stringify([m.modifierId, m.optLabel])),
    );
    if (bad) {
      return NextResponse.json({ error: "modifier_option_not_found" }, { status: 400 });
    }
  }

  // Todos los insumos (base + deltas) deben ser del comercio y estar activos.
  const allIds = [...new Set([...ids, ...b.modifierItems.map((m) => m.ingredientId)])];
  const ingredients = await db.ingredient.findMany({
    where: { id: { in: allIds }, restaurantId: ctx.restaurantId, active: true },
    select: { id: true },
  });
  if (ingredients.length !== allIds.length) {
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
    await tx.modifierRecipeItem.deleteMany({ where: { recipeId: r.id } });
    if (b.modifierItems.length > 0) {
      await tx.modifierRecipeItem.createMany({
        data: b.modifierItems.map((m) => ({ recipeId: r.id, ...m })),
      });
    }
    return tx.recipe.findUniqueOrThrow({
      where: { id: r.id },
      select: {
        id: true,
        notes: true,
        items: { select: { ingredientId: true, qtyBase: true, wastePct: true } },
        modifierItems: {
          select: {
            modifierId: true,
            optLabel: true,
            ingredientId: true,
            qtyBase: true,
            wastePct: true,
          },
        },
      },
    });
  });

  const { ctx: costCtx } = await loadCostContext(ctx.restaurantId);
  const cost = costRecipeItems(costCtx, recipe.items);
  return NextResponse.json({ recipe, cost });
}
