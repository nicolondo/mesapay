// Capa de datos del costeo de recetas (ERP A3) — carga desde DB el
// CostContext que consume la lógica pura de src/lib/erp/recipes.ts y
// resuelve la detección de ciclos al escribir sub-recetas.
import { db } from "@/lib/db";
import type { MeasureKind, Prisma } from "@prisma/client";
import { resolveIngredientCost, type CostContext, type CostSource, type RecipeLine } from "@/lib/erp/recipes";
import { loadPurchaseCosts } from "@/lib/erp/purchaseCostData";
import type { PurchaseCostDTO } from "@/lib/erp/purchaseCost";

export type IngredientMeta = {
  id: string;
  name: string;
  measureKind: MeasureKind;
  active: boolean;
  trackInventory: boolean;
};

export type IngredientCostView = {
  costPerBase: number | null;
  costSource: CostSource;
  purchaseCost: PurchaseCostDTO | null;
};

export const EMPTY_INGREDIENT_COST_VIEW: IngredientCostView = {
  costPerBase: null, costSource: null, purchaseCost: null,
};

/**
 * Carga TODOS los insumos del comercio con lo que la cascada D3 necesita
 * (stock, referencia manual, compra recibida, proveedor preferido, sub-receta). Una pasada por request:
 * el costeo después es puro y en memoria.
 */
export async function loadCostContext(restaurantId: string): Promise<{
  ctx: CostContext;
  meta: Map<string, IngredientMeta>;
  purchaseCosts: Map<string, PurchaseCostDTO>;
}> {
  const ingredients = await db.ingredient.findMany({
    where: { restaurantId },
    select: {
      id: true,
      name: true,
      measureKind: true,
      active: true,
      trackInventory: true,
      referencePriceCents: true,
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

  const purchaseCosts = await loadPurchaseCosts(restaurantId, ingredients.map((ingredient) => ingredient.id));

  const ctx: CostContext = new Map();
  const meta = new Map<string, IngredientMeta>();
  for (const ing of ingredients) {
    ctx.set(ing.id, {
      stock: ing.stockLevel,
      referencePriceCents: ing.referencePriceCents,
      purchase: purchaseCosts.get(ing.id) ?? null,
      preferred: ing.supplierItems[0] ?? null,
      recipe: ing.recipe,
    });
    meta.set(ing.id, {
      id: ing.id,
      name: ing.name,
      measureKind: ing.measureKind,
      active: ing.active,
      trackInventory: ing.trackInventory,
    });
  }
  return { ctx, meta, purchaseCosts };
}

/** Catalog and mutation DTOs share exactly the recipe cost cascade. */
export async function loadIngredientCostViews(restaurantId: string): Promise<Map<string, IngredientCostView>> {
  const { ctx, purchaseCosts } = await loadCostContext(restaurantId);
  return new Map([...ctx.keys()].map((id) => {
    const cost = resolveIngredientCost(ctx, id);
    return [id, {
      costPerBase: cost?.costPerBase ?? null,
      costSource: cost?.source ?? null,
      purchaseCost: purchaseCosts.get(id) ?? null,
    }];
  }));
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
