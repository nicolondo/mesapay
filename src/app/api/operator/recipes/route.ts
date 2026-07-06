import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { costRecipeItems } from "@/lib/erp/recipes";
import { loadCostContext } from "@/lib/erp/recipeData";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["recipes"];

/**
 * Vista completa de recetas del comercio: la carta con costo/food cost/
 * margen derivados EN VIVO (spec D3 — nada persistido) + las sub-recetas
 * con su costo por unidad base. Los platos no disponibles se incluyen
 * (con su flag) — que un plato salga de carta una noche no borra su
 * receta del editor.
 */
export async function GET() {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }

  const [{ ctx: costCtx, meta }, menuItems] = await Promise.all([
    loadCostContext(ctx.restaurantId),
    db.menuItem.findMany({
      where: { restaurantId: ctx.restaurantId },
      orderBy: [{ category: { sortOrder: "asc" } }, { sortOrder: "asc" }],
      select: {
        id: true,
        name: true,
        priceCents: true,
        available: true,
        category: { select: { id: true, label: true } },
        recipe: {
          select: {
            id: true,
            notes: true,
            items: {
              select: { ingredientId: true, qtyBase: true, wastePct: true },
            },
          },
        },
      },
    }),
  ]);

  const dishes = menuItems.map((mi) => {
    if (!mi.recipe) {
      return {
        menuItemId: mi.id,
        name: mi.name,
        category: mi.category,
        priceCents: mi.priceCents,
        available: mi.available,
        recipe: null,
        cost: null,
      };
    }
    const cost = costRecipeItems(costCtx, mi.recipe.items);
    return {
      menuItemId: mi.id,
      name: mi.name,
      category: mi.category,
      priceCents: mi.priceCents,
      available: mi.available,
      recipe: {
        id: mi.recipe.id,
        notes: mi.recipe.notes,
        items: mi.recipe.items.map((it) => ({
          ...it,
          ingredientName: meta.get(it.ingredientId)?.name ?? "",
          measureKind: meta.get(it.ingredientId)?.measureKind ?? "count",
        })),
      },
      cost,
    };
  });

  // Sub-recetas: insumos del contexto que tienen receta propia.
  const subRecipes = await db.recipe.findMany({
    where: { restaurantId: ctx.restaurantId, outputIngredientId: { not: null } },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      outputIngredientId: true,
      outputQtyBase: true,
      notes: true,
      items: { select: { ingredientId: true, qtyBase: true, wastePct: true } },
    },
  });
  const subs = subRecipes.map((r) => {
    const outMeta = meta.get(r.outputIngredientId!);
    const stock = costCtx.get(r.outputIngredientId!)?.stock;
    const cost = costRecipeItems(costCtx, r.items, new Set([r.outputIngredientId!]), 1);
    return {
      recipeId: r.id,
      ingredientId: r.outputIngredientId!,
      ingredientName: outMeta?.name ?? "",
      measureKind: outMeta?.measureKind ?? "count",
      active: outMeta?.active ?? false,
      outputQtyBase: r.outputQtyBase,
      notes: r.notes,
      items: r.items.map((it) => ({
        ...it,
        ingredientName: meta.get(it.ingredientId)?.name ?? "",
        measureKind: meta.get(it.ingredientId)?.measureKind ?? "count",
      })),
      cost,
      // Derivado por unidad base (para comparar contra el promedio real).
      derivedCostPerBase:
        cost.complete && r.outputQtyBase
          ? cost.costCents / r.outputQtyBase
          : null,
      stockAvgCostPerBase:
        stock && stock.qtyBase > 0 ? stock.totalValueCents / stock.qtyBase : null,
    };
  });

  return NextResponse.json({ dishes, subRecipes: subs });
}
