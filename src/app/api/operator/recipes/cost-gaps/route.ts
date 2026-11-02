import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { loadCostContext } from "@/lib/erp/recipeData";
import { computeRecipeCostGaps } from "@/lib/erp/recipeCostGaps";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["recipes"];

/**
 * Platos con costo incompleto: los que tienen algún insumo (directo o dentro
 * de una sub-receta que el costeo usa) sin fuente de costo o en cero. Derivado
 * EN VIVO con la misma cascada D3 que el resto de la app — nada persistido.
 *
 * `items`: sólo los platos afectados, en el orden de la carta, con sus
 * insumos culpables (hoja + cadena de sub-recetas por la que llega).
 * `ingredientsWithoutCost`: los insumos culpables, los que más platos
 * afectan primero — arreglar uno recalcula todos los platos que lo usan.
 */
async function GETHandler() {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }

  const [{ ctx: costCtx, meta }, menuItems] = await Promise.all([
    loadCostContext(ctx.restaurantId),
    db.menuItem.findMany({
      where: { restaurantId: ctx.restaurantId, recipe: { isNot: null } },
      orderBy: [{ category: { sortOrder: "asc" } }, { sortOrder: "asc" }],
      select: {
        id: true,
        name: true,
        category: { select: { label: true } },
        recipe: {
          select: {
            items: {
              select: { ingredientId: true, qtyBase: true, wastePct: true },
            },
          },
        },
      },
    }),
  ]);

  const gaps = computeRecipeCostGaps(
    costCtx,
    menuItems.map((mi) => ({
      menuItemId: mi.id,
      name: mi.name,
      categoryName: mi.category.label,
      items: mi.recipe?.items ?? [],
    })),
  );

  const nameOf = (id: string) => meta.get(id)?.name ?? "";
  const kindOf = (id: string) => meta.get(id)?.measureKind ?? "count";

  const items = gaps.dishes.map((d) => ({
    menuItemId: d.menuItemId,
    name: d.name,
    categoryName: d.categoryName,
    costCents: d.costCents,
    complete: d.complete,
    missing: d.missing.map((m) => ({
      ingredientId: m.ingredientId,
      name: nameOf(m.ingredientId),
      measureKind: kindOf(m.ingredientId),
      qtyBase: m.qtyBase,
      reason: m.reason,
      via: m.via.map(nameOf),
    })),
  }));

  const ingredientsWithoutCost = gaps.ingredients.map((i) => ({
    id: i.ingredientId,
    name: nameOf(i.ingredientId),
    measureKind: kindOf(i.ingredientId),
    reason: i.reason,
    usedInCount: i.usedInCount,
    // Precarga del campo "poner costo" (la referencia manual es la fuente
    // que el operador puede corregir en línea).
    referencePriceCents: costCtx.get(i.ingredientId)?.referencePriceCents ?? null,
  }));

  return NextResponse.json({ items, ingredientsWithoutCost });
}

export const GET = secureApi(GETHandler);
