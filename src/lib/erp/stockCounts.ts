import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { lockStock } from "@/lib/orderLock";
import { applyStockMovement } from "@/lib/erp/stock";

export const stockCountInclude = {
  createdBy: { select: { name: true } },
  items: {
    include: {
      ingredient: { select: { id: true, name: true, measureKind: true, category: true, active: true, barcode: true, trackInventory: true } },
    },
    orderBy: { ingredient: { name: "asc" as const } },
  },
} as const;

export class StockCountError extends Error {
  constructor(public code: string, public status = 409) { super(code); }
}

type Count = Prisma.StockCountGetPayload<{ include: typeof stockCountInclude }>;
type Snapshot = { movementCount: number; ingredients: { id: string; trackInventory: boolean; measureKind: string; qtyBase: number; totalValueCents: number }[] };
export type StockCountAction = "save" | "preliminary" | "recount" | "review" | "close" | "delete";
export type StockCountInput = { revision: number; items?: { itemId: string; countedQty: number | null }[]; reviewToken?: string };

/** Snapshots are scoped to this count's ingredients, so unrelated stock moves
 * do not interrupt a recount. Movement count also detects net-zero changes. */
async function stockSnapshot(tx: Prisma.TransactionClient, restaurantId: string, count: Count): Promise<Snapshot> {
  const ids = count.items.map((item) => item.ingredientId);
  const ingredients = await tx.ingredient.findMany({
    where: { restaurantId, id: { in: ids } },
    select: { id: true, trackInventory: true, measureKind: true, stockLevel: { select: { qtyBase: true, totalValueCents: true } } },
    orderBy: { id: "asc" },
  });
  const movementCount = await tx.stockMovement.count({ where: { restaurantId, ingredientId: { in: ids } } });
  return { movementCount, ingredients: ingredients.map((i) => ({ id: i.id, trackInventory: i.trackInventory, measureKind: i.measureKind, qtyBase: i.stockLevel?.qtyBase ?? 0, totalValueCents: i.stockLevel?.totalValueCents ?? 0 })) };
}

export function sameStockSnapshot(stored: unknown, live: unknown): boolean {
  // Both objects originate from stockSnapshot and are stored as JSONB, whose
  // key order is unspecified. Compare values, never JSON serialization order.
  if (!stored || !live || typeof stored !== "object" || typeof live !== "object") return false;
  const a = stored as Snapshot; const b = live as Snapshot;
  if (!Array.isArray(a.ingredients) || !Array.isArray(b.ingredients) || a.movementCount !== b.movementCount || a.ingredients.length !== b.ingredients.length) return false;
  return a.ingredients.every((item, index) => {
    const other = b.ingredients[index];
    return item.id === other.id && item.trackInventory === other.trackInventory && item.measureKind === other.measureKind && item.qtyBase === other.qtyBase && item.totalValueCents === other.totalValueCents;
  });
}

/** Every writer uses the same restaurant lock as stock movements. This makes
 * saves/closure atomic, prevents duplicate open sessions and preserves sales.
 * No stock is changed until close validates the persisted final-review token. */
export async function mutateStockCount(restaurantId: string, id: string, action: StockCountAction, input: StockCountInput, createdById: string | null = null) {
  return db.$transaction(async (tx) => {
    await lockStock(tx, restaurantId);
    const count = await tx.stockCount.findFirst({ where: { id, restaurantId }, include: stockCountInclude });
    if (!count) throw new StockCountError("not_found", 404);
    if (count.status === "closed") throw new StockCountError("already_closed");
    if (count.revision !== input.revision) throw new StockCountError("count_changed");
    if (action === "delete") {
      await tx.stockCount.delete({ where: { id } });
      return { ok: true };
    }
    const revision = count.revision + 1;
    let adjustments: number | undefined;
    const common = { revision, finalReview: Prisma.DbNull };
    if (action === "save") {
      if (count.preliminaryAt && !count.recountStartedAt) throw new StockCountError("recount_required");
      const owned = new Set(count.items.map((item) => item.id));
      const changes = input.items ?? [];
      if (!changes.length || new Set(changes.map((item) => item.itemId)).size !== changes.length || changes.some((item) => !owned.has(item.itemId))) throw new StockCountError("invalid", 400);
      for (const item of changes) await tx.stockCountItem.update({ where: { id: item.itemId }, data: { countedQty: item.countedQty } });
      await tx.stockCount.update({ where: { id }, data: common });
    } else if (action === "preliminary") {
      if (count.preliminaryAt) throw new StockCountError("count_changed");
      if (!count.items.some((item) => item.ingredient.trackInventory && item.countedQty !== null)) throw new StockCountError("empty_count", 400);
      for (const item of count.items) await tx.stockCountItem.update({ where: { id: item.id }, data: { preliminaryQty: item.countedQty } });
      await tx.stockCount.update({ where: { id }, data: { ...common, preliminaryAt: new Date() } });
    } else if (action === "recount") {
      if (!count.preliminaryAt) throw new StockCountError("preliminary_required");
      const snapshot = await stockSnapshot(tx, restaurantId, count);
      if (!snapshot.ingredients.some((i) => i.trackInventory)) throw new StockCountError("empty_count", 400);
      const levels = new Map(snapshot.ingredients.map((i) => [i.id, i.qtyBase]));
      for (const item of count.items) await tx.stockCountItem.update({ where: { id: item.id }, data: { countedQty: null, finalExpectedQty: levels.get(item.ingredientId) ?? 0 } });
      await tx.stockCount.update({ where: { id }, data: { ...common, recountStartedAt: new Date(), recountSnapshot: snapshot } });
    } else {
      if (!count.preliminaryAt) throw new StockCountError("preliminary_required");
      if (!count.recountStartedAt || !count.recountSnapshot) throw new StockCountError("recount_required");
      const live = await stockSnapshot(tx, restaurantId, count);
      if (!sameStockSnapshot(count.recountSnapshot, live)) throw new StockCountError("stock_changed");
      const tracked = count.items.filter((item) => item.ingredient.trackInventory);
      if (!tracked.length) throw new StockCountError("empty_count", 400);
      if (tracked.some((item) => item.countedQty === null || item.finalExpectedQty === null)) throw new StockCountError("incomplete_count", 400);
      if (tracked.some((item) => Math.abs(item.countedQty! - item.finalExpectedQty!) > 2_000_000_000)) throw new StockCountError("qty_invalid", 400);
      if (action === "review") {
        const finalReview = { token: randomUUID(), revision, reviewedAt: new Date().toISOString(), counted: tracked.length, differences: tracked.filter((item) => item.countedQty !== item.finalExpectedQty).length };
        await tx.stockCount.update({ where: { id }, data: { revision, finalReview } });
      } else if (action === "close") {
        const review = count.finalReview as { token?: string; revision?: number } | null;
        if (!review || review.revision !== count.revision || !input.reviewToken || review.token !== input.reviewToken) throw new StockCountError("review_required");
        adjustments = 0;
        for (const item of tracked) {
          const diff = item.countedQty! - item.finalExpectedQty!;
          if (!diff) continue;
          await applyStockMovement(tx, { restaurantId, ingredientId: item.ingredientId, kind: "count_adjust", qtyBase: diff, stockCountId: id, createdById }, { allowInactive: true });
          adjustments++;
        }
        await tx.stockCount.update({ where: { id }, data: { revision, status: "closed", closedAt: new Date() } });
      }
    }
    const updated = await tx.stockCount.findUniqueOrThrow({ where: { id }, include: stockCountInclude });
    return { count: updated, ...(adjustments === undefined ? {} : { adjustments }) };
  }, { timeout: 30_000 });
}
