// Consumo automático de inventario por venta (ERP Fase A4).
//
// Cuando una orden queda `paid`, sus items explotan las recetas (A3) y
// descuentan insumos con movimientos `sale_consumption` (A1). Dos
// disparadores llaman consumeOrderStock: el hook de `order.paid` en el
// bus de eventos (best-effort, inmediato) y el cron de respaldo
// /api/cron/stock-consumption. Idempotente: Order.stockConsumedAt se
// reclama en la MISMA transacción que escribe los movimientos.
import { db } from "@/lib/db";
import { isModuleEnabled } from "@/lib/modules";
import { applyStockMovement } from "@/lib/erp/stock";
import { grossQty } from "@/lib/erp/recipes";

export type ConsumableItem = {
  menuItemId: string;
  qty: number;
  cancelledAt: Date | null;
  /** "cancel" | "comp" | null (null viejo = cancel, back-compat). */
  cancellationKind: string | null;
  roundCancelled: boolean;
};

export type ConsumptionRecipe = {
  items: Array<{ ingredientId: string; qtyBase: number; wastePct: number }>;
};

/**
 * Matemática pura del consumo (testeable sin DB): agrega por insumo el
 * BRUTO total de los items consumibles.
 *
 * Reglas (spec D2):
 * - Items vivos consumen; los comp también (se prepararon aunque no se
 *   cobren); los cancel y los de rounds cancelados no.
 * - Por línea de receta: bruto = neto/(1−merma%), redondeado a entero en
 *   unidad base, × qty del item.
 * - Plato sin receta no aporta nada.
 */
export function explodeOrderConsumption(
  items: ConsumableItem[],
  recipes: Map<string, ConsumptionRecipe>,
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const it of items) {
    if (it.roundCancelled) continue;
    if (it.cancelledAt && it.cancellationKind !== "comp") continue;
    if (it.qty <= 0) continue;
    const recipe = recipes.get(it.menuItemId);
    if (!recipe) continue;
    for (const line of recipe.items) {
      const grossPerPortion = Math.round(grossQty(line.qtyBase, line.wastePct));
      const qty = grossPerPortion * it.qty;
      if (qty <= 0) continue;
      totals.set(line.ingredientId, (totals.get(line.ingredientId) ?? 0) + qty);
    }
  }
  return totals;
}

export type ConsumeResult =
  | { status: "consumed"; movements: number }
  | { status: "already" | "not_paid" | "not_found" | "modules_off" };

/**
 * Descuenta el inventario de UNA orden pagada. Seguro de llamar N veces
 * y desde varios workers a la vez (claim race-safe). Nunca debe tumbar
 * al caller del pago: los disparadores capturan y loguean.
 *
 * Con módulos inventory/recipes apagados la orden se marca consumida SIN
 * movimientos: activar los módulos después no retro-descuenta ventas
 * viejas (spec D2 — el arranque es conteo inicial y de ahí en adelante).
 */
export async function consumeOrderStock(orderId: string): Promise<ConsumeResult> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      restaurantId: true,
      status: true,
      stockConsumedAt: true,
      restaurant: {
        select: { enabledModules: true, inventoryExcludedCategories: true },
      },
    },
  });
  if (!order) return { status: "not_found" };
  if (order.status !== "paid") return { status: "not_paid" };
  if (order.stockConsumedAt) return { status: "already" };

  const modulesOn =
    isModuleEnabled(order.restaurant.enabledModules, "inventory") &&
    isModuleEnabled(order.restaurant.enabledModules, "recipes");

  let totals = new Map<string, number>();
  if (modulesOn) {
    const items = await db.orderItem.findMany({
      where: { orderId },
      select: {
        menuItemId: true,
        qty: true,
        cancelledAt: true,
        cancellationKind: true,
        round: { select: { status: true } },
      },
    });
    const menuItemIds = [...new Set(items.map((i) => i.menuItemId))];
    const recipes = await db.recipe.findMany({
      where: {
        restaurantId: order.restaurantId,
        menuItemId: { in: menuItemIds },
      },
      select: {
        menuItemId: true,
        items: {
          select: { ingredientId: true, qtyBase: true, wastePct: true },
        },
      },
    });
    const recipeMap = new Map<string, ConsumptionRecipe>(
      recipes
        .filter((r) => r.menuItemId)
        .map((r) => [r.menuItemId!, { items: r.items }]),
    );
    totals = explodeOrderConsumption(
      items.map((i) => ({
        menuItemId: i.menuItemId,
        qty: i.qty,
        cancelledAt: i.cancelledAt,
        cancellationKind: i.cancellationKind,
        roundCancelled: i.round?.status === "cancelled",
      })),
      recipeMap,
    );

    // Categorías sin inventario: sus insumos no consumen stock aunque la
    // receta los use (agua de la llave, servicios, etc.).
    const excluded = order.restaurant.inventoryExcludedCategories;
    if (excluded.length > 0 && totals.size > 0) {
      const ings = await db.ingredient.findMany({
        where: { id: { in: [...totals.keys()] } },
        select: { id: true, category: true },
      });
      const skip = new Set(excluded);
      for (const ing of ings) {
        if (ing.category && skip.has(ing.category)) totals.delete(ing.id);
      }
    }
  }

  return db.$transaction(async (tx) => {
    // Claim idempotente: si otro worker ya marcó, no tocamos nada.
    const claim = await tx.order.updateMany({
      where: { id: orderId, stockConsumedAt: null },
      data: { stockConsumedAt: new Date() },
    });
    if (claim.count === 0) return { status: "already" as const };

    let movements = 0;
    for (const [ingredientId, qtyBase] of totals) {
      await applyStockMovement(
        tx,
        {
          restaurantId: order.restaurantId,
          ingredientId,
          kind: "sale_consumption",
          qtyBase,
          orderId,
        },
        // Un insumo descatalogado con receta viva sigue consumiendo —
        // mismo criterio que los cierres de conteo.
        { allowInactive: true },
      );
      movements++;
    }
    return modulesOn
      ? { status: "consumed" as const, movements }
      : { status: "modules_off" as const };
  });
}

/**
 * Barrido de respaldo (cron): procesa órdenes pagadas sin consumir de las
 * últimas 48 h. Cubre caídas del proceso, deploys a mitad de pago y paths
 * que no publiquen `order.paid`.
 */
export async function sweepUnconsumedOrders(): Promise<{
  scanned: number;
  consumed: number;
  modulesOff: number;
  errors: number;
}> {
  const since = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const orders = await db.order.findMany({
    where: { status: "paid", stockConsumedAt: null, paidAt: { gte: since } },
    select: { id: true },
    orderBy: { paidAt: "asc" },
    take: 500,
  });
  let consumed = 0;
  let modulesOff = 0;
  let errors = 0;
  for (const o of orders) {
    try {
      const r = await consumeOrderStock(o.id);
      if (r.status === "consumed") consumed++;
      else if (r.status === "modules_off") modulesOff++;
    } catch (err) {
      errors++;
      console.error(`[consumption] sweep order ${o.id}`, err);
    }
  }
  return { scanned: orders.length, consumed, modulesOff, errors };
}
