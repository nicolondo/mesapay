import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { costRecipeItems, resolveIngredientCost } from "@/lib/erp/recipes";
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

  // Catálogo de insumos con su costo resuelto (cascada D3) — alimenta el
  // picker del editor y el recálculo de costos EN VIVO en el cliente sin
  // otro fetch: costo de línea = round(bruto × costPerBase).
  const ingredients = [...meta.values()]
    .filter((m) => m.active)
    .map((m) => {
      const cost = resolveIngredientCost(costCtx, m.id);
      return {
        id: m.id,
        name: m.name,
        measureKind: m.measureKind,
        costPerBase: cost?.costPerBase ?? null,
        costSource: cost?.source ?? null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  // Insumos al alza (A4 · D5): último precio del historial (A2) vs. el
  // registro anterior del MISMO supplier-item — alza ≥ 10% dentro de los
  // últimos 30 días. Derivado en vivo, nada persistido.
  const priceAlerts = await computePriceAlerts(
    ctx.restaurantId,
    meta,
    costCtx,
    dishes,
  );

  return NextResponse.json({ dishes, subRecipes: subs, ingredients, priceAlerts });
}

const PRICE_ALERT_WINDOW_DAYS = 30;
const PRICE_ALERT_MIN_PCT = 10;

type DishForAlerts = {
  name: string;
  recipe: { items: Array<{ ingredientId: string }> } | null;
};

async function computePriceAlerts(
  restaurantId: string,
  meta: Awaited<ReturnType<typeof loadCostContext>>["meta"],
  costCtx: Awaited<ReturnType<typeof loadCostContext>>["ctx"],
  dishes: DishForAlerts[],
) {
  const since = new Date(
    Date.now() - PRICE_ALERT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  // Trae el historial reciente + 1 registro anterior por item (tomamos un
  // rango generoso y resolvemos "último vs. anterior" en memoria — el
  // volumen por comercio es chico).
  const history = await db.supplierPriceHistory.findMany({
    where: { supplierItem: { supplier: { restaurantId } } },
    orderBy: { createdAt: "desc" },
    take: 2000,
    select: {
      supplierItemId: true,
      priceCents: true,
      createdAt: true,
      supplierItem: {
        select: {
          ingredientId: true,
          presentationLabel: true,
          supplier: { select: { name: true } },
        },
      },
    },
  });

  // Platos afectados por insumo: uso directo + a través de sub-recetas
  // (el insumo elaborado propaga a los platos que lo usan, tope 3 niveles
  // — mismo límite del costeo).
  const usedBy = new Map<string, Set<string>>();
  const expand = (ingredientId: string, depth: number): string[] => {
    const sub = costCtx.get(ingredientId)?.recipe;
    const own = [ingredientId];
    if (!sub || depth >= 3) return own;
    return own.concat(
      sub.items.flatMap((it) => expand(it.ingredientId, depth + 1)),
    );
  };
  for (const d of dishes) {
    if (!d.recipe) continue;
    for (const it of d.recipe.items) {
      for (const ing of expand(it.ingredientId, 0)) {
        let set = usedBy.get(ing);
        if (!set) usedBy.set(ing, (set = new Set()));
        set.add(d.name);
      }
    }
  }

  const byItem = new Map<string, typeof history>();
  for (const h of history) {
    let list = byItem.get(h.supplierItemId);
    if (!list) byItem.set(h.supplierItemId, (list = []));
    if (list.length < 2) list.push(h);
  }

  const alerts: Array<{
    ingredientId: string;
    ingredientName: string;
    supplierName: string;
    presentationLabel: string;
    prevPriceCents: number;
    lastPriceCents: number;
    pctIncrease: number;
    at: Date;
    dishes: string[];
    dishCount: number;
  }> = [];
  for (const [, records] of byItem) {
    if (records.length < 2) continue;
    const [last, prev] = records;
    if (last.createdAt < since) continue;
    if (prev.priceCents <= 0) continue;
    const pct = ((last.priceCents - prev.priceCents) / prev.priceCents) * 100;
    if (pct < PRICE_ALERT_MIN_PCT) continue;
    const ingredientId = last.supplierItem.ingredientId;
    const ingMeta = meta.get(ingredientId);
    if (!ingMeta || !ingMeta.active) continue;
    const dishNames = [...(usedBy.get(ingredientId) ?? [])];
    alerts.push({
      ingredientId,
      ingredientName: ingMeta.name,
      supplierName: last.supplierItem.supplier.name,
      presentationLabel: last.supplierItem.presentationLabel,
      prevPriceCents: prev.priceCents,
      lastPriceCents: last.priceCents,
      pctIncrease: Math.round(pct * 10) / 10,
      at: last.createdAt,
      dishes: dishNames.slice(0, 6),
      dishCount: dishNames.length,
    });
  }
  return alerts.sort((a, b) => b.pctIncrease - a.pctIncrease);
}
