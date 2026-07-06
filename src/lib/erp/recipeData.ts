// Capa de datos del costeo de recetas (ERP A3) — carga desde DB el
// CostContext que consume la lógica pura de src/lib/erp/recipes.ts y
// resuelve la detección de ciclos al escribir sub-recetas.
import { db } from "@/lib/db";
import type { MeasureKind, Prisma } from "@prisma/client";
import type { CostContext, RecipeLine } from "@/lib/erp/recipes";

export type IngredientMeta = {
  id: string;
  name: string;
  measureKind: MeasureKind;
  active: boolean;
};

/**
 * Carga TODOS los insumos del comercio con lo que la cascada D3 necesita
 * (stock, proveedor preferido, sub-receta). Una sola pasada por request:
 * el costeo después es puro y en memoria.
 */
export async function loadCostContext(restaurantId: string): Promise<{
  ctx: CostContext;
  meta: Map<string, IngredientMeta>;
}> {
  const ingredients = await db.ingredient.findMany({
    where: { restaurantId },
    select: {
      id: true,
      name: true,
      measureKind: true,
      active: true,
      stockLevel: { select: { qtyBase: true, totalValueCents: true } },
      supplierItems: {
        where: { preferred: true },
        take: 1,
        select: { lastPriceCents: true, contentQty: true },
      },
      recipe: {
        select: {
          outputQtyBase: true,
          items: {
            select: { ingredientId: true, qtyBase: true, wastePct: true },
          },
        },
      },
    },
  });

  const ctx: CostContext = new Map();
  const meta = new Map<string, IngredientMeta>();
  for (const ing of ingredients) {
    ctx.set(ing.id, {
      stock: ing.stockLevel,
      preferred: ing.supplierItems[0] ?? null,
      recipe: ing.recipe,
    });
    meta.set(ing.id, {
      id: ing.id,
      name: ing.name,
      measureKind: ing.measureKind,
      active: ing.active,
    });
  }
  return { ctx, meta };
}

/**
 * ¿Guardar `items` como sub-receta de `outputIngredientId` crearía un
 * ciclo? Grafo insumo → insumos de su sub-receta, con la arista nueva
 * reemplazando a la existente; ciclo = el output se alcanza a sí mismo.
 */
export async function wouldCreateCycle(
  tx: Prisma.TransactionClient,
  restaurantId: string,
  outputIngredientId: string,
  items: Pick<RecipeLine, "ingredientId">[],
): Promise<boolean> {
  const subRecipes = await tx.recipe.findMany({
    where: { restaurantId, outputIngredientId: { not: null } },
    select: {
      outputIngredientId: true,
      items: { select: { ingredientId: true } },
    },
  });
  const graph = new Map<string, string[]>();
  for (const r of subRecipes) {
    if (!r.outputIngredientId) continue;
    graph.set(
      r.outputIngredientId,
      r.items.map((i) => i.ingredientId),
    );
  }
  graph.set(
    outputIngredientId,
    items.map((i) => i.ingredientId),
  );

  const visited = new Set<string>();
  const stack = [...(graph.get(outputIngredientId) ?? [])];
  while (stack.length) {
    const node = stack.pop()!;
    if (node === outputIngredientId) return true;
    if (visited.has(node)) continue;
    visited.add(node);
    stack.push(...(graph.get(node) ?? []));
  }
  return false;
}
