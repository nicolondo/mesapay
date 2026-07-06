import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import {
  costRecipeItems,
  engineeringQuadrant,
  engineeringThresholds,
} from "@/lib/erp/recipes";
import { loadCostContext } from "@/lib/erp/recipeData";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["recipes"];

const PERIODS = [7, 30, 90];

/**
 * Matriz de ingeniería de menú (spec D4): popularidad = unidades vendidas
 * en órdenes pagadas del período (items cancelados/comp excluidos); margen
 * = precio de carta − costo ACTUAL de la receta. Umbrales: popularidad ≥
 * 70% del promedio de unidades por plato; margen ≥ promedio. Platos sin
 * receta, con costo incompleto o sin ventas van a la lista "sin datos".
 */
export async function GET(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { searchParams } = new URL(req.url);
  const daysParam = Number(searchParams.get("days"));
  const days = PERIODS.includes(daysParam) ? daysParam : 30;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [{ ctx: costCtx }, menuItems, sold] = await Promise.all([
    loadCostContext(ctx.restaurantId),
    db.menuItem.findMany({
      where: { restaurantId: ctx.restaurantId },
      select: {
        id: true,
        name: true,
        priceCents: true,
        available: true,
        category: { select: { id: true, label: true } },
        recipe: {
          select: {
            items: {
              select: { ingredientId: true, qtyBase: true, wastePct: true },
            },
          },
        },
      },
    }),
    db.orderItem.groupBy({
      by: ["menuItemId"],
      where: {
        cancelledAt: null,
        order: { restaurantId: ctx.restaurantId, paidAt: { gte: since } },
      },
      _sum: { qty: true },
    }),
  ]);

  const unitsByItem = new Map(
    sold.map((s) => [s.menuItemId, s._sum.qty ?? 0]),
  );

  type Candidate = {
    menuItemId: string;
    name: string;
    category: { id: string; label: string };
    priceCents: number;
    available: boolean;
    unitsSold: number;
    costCents: number;
    marginCents: number;
  };
  const candidates: Candidate[] = [];
  const noData: Array<{
    menuItemId: string;
    name: string;
    category: { id: string; label: string };
    available: boolean;
    unitsSold: number;
    reason: "no_recipe" | "incomplete_cost" | "no_sales";
  }> = [];

  for (const mi of menuItems) {
    const unitsSold = unitsByItem.get(mi.id) ?? 0;
    const base = {
      menuItemId: mi.id,
      name: mi.name,
      category: mi.category,
      available: mi.available,
      unitsSold,
    };
    if (!mi.recipe || mi.recipe.items.length === 0) {
      noData.push({ ...base, reason: "no_recipe" });
      continue;
    }
    const cost = costRecipeItems(costCtx, mi.recipe.items);
    if (!cost.complete) {
      noData.push({ ...base, reason: "incomplete_cost" });
      continue;
    }
    if (unitsSold === 0) {
      noData.push({ ...base, reason: "no_sales" });
      continue;
    }
    candidates.push({
      ...base,
      priceCents: mi.priceCents,
      costCents: cost.costCents,
      marginCents: mi.priceCents - cost.costCents,
    });
  }

  const { popularityThreshold, marginThreshold } =
    engineeringThresholds(candidates);
  const dishes = candidates
    .map((c) => ({
      ...c,
      quadrant: engineeringQuadrant(
        c.unitsSold,
        c.marginCents,
        popularityThreshold,
        marginThreshold,
      ),
    }))
    .sort((a, b) => b.unitsSold - a.unitsSold);

  return NextResponse.json({
    days,
    popularityThreshold,
    marginThreshold,
    dishes,
    noData,
  });
}
