import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { lockStock } from "@/lib/orderLock";
import { applyStockMovement } from "@/lib/erp/stock";
import { effectiveCountParts, isValidCountParts, isValidCountQuantity } from "@/lib/erp/stockCountParts";
import { recountReasons, type RecountReason } from "@/lib/erp/recountPlan";

export const stockCountInclude = {
  createdBy: { select: { name: true } },
  items: {
    include: {
      ingredient: {
        select: {
          id: true, name: true, measureKind: true, category: true, active: true, barcode: true, trackInventory: true,
          barcodes: { select: { barcode: true }, orderBy: { barcode: "asc" } },
        },
      },
    },
    orderBy: { ingredient: { name: "asc" as const } },
  },
} as const;

export class StockCountError extends Error {
  constructor(public code: string, public status = 409) { super(code); }
}

type Count = Prisma.StockCountGetPayload<{ include: typeof stockCountInclude }>;
// `recount`/`full` son el plan del definitivo (ver recountPlan.ts): qué se
// pidió recontar y por qué. No participan en la comparación de inventario.
type Snapshot = {
  movementCount: number;
  ingredients: { id: string; trackInventory: boolean; measureKind: string; qtyBase: number; totalValueCents: number }[];
  recount?: Record<string, RecountReason[]>;
  full?: boolean;
};
export type StockCountAction = "save" | "preliminary" | "recount" | "review" | "close" | "delete";
export type StockCountInput = {
  revision: number;
  items?: { itemId: string; countedQty: number | null; countedParts?: number[] }[];
  reviewToken?: string;
  /** Solo `recount`: «Recontar todo» — nada se arrastra del preliminar. */
  full?: boolean;
};

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
  // By id, not by position: an item appended during the recount is stored at
  // the end, while the live query returns ids in database order.
  const live_ = new Map(b.ingredients.map((item) => [item.id, item]));
  if (live_.size !== b.ingredients.length) return false;
  return a.ingredients.every((item) => {
    const other = live_.get(item.id);
    return !!other && item.trackInventory === other.trackInventory && item.measureKind === other.measureKind && item.qtyBase === other.qtyBase && item.totalValueCents === other.totalValueCents;
  });
}

/**
 * Suma un insumo a un conteo en BORRADOR (alta desde la pantalla del conteo:
 * se creó, se restauró o quedó por fuera al abrirlo). Mismo lock de stock y
 * la misma revisión optimista que el resto de escrituras.
 *
 * Solo en las etapas editables —conteo inicial o definitivo—, nunca sobre el
 * informe preliminar ni con la revisión final pendiente. El teórico es la
 * existencia de ESE momento (0 para un insumo recién creado). En el conteo
 * definitivo también entra a `recountSnapshot`, con su saldo y sus
 * movimientos de ahora, para que el cierre no lo confunda con un cambio de
 * inventario y siga detectando los cambios de los demás.
 */
export async function appendStockCountItem(restaurantId: string, id: string, input: { revision: number; ingredientId: string }) {
  return db.$transaction(async (tx) => {
    await lockStock(tx, restaurantId);
    const count = await tx.stockCount.findFirst({ where: { id, restaurantId }, include: stockCountInclude });
    if (!count) throw new StockCountError("not_found", 404);
    if (count.status === "closed") throw new StockCountError("already_closed");
    if (count.revision !== input.revision) throw new StockCountError("count_changed");
    if (count.preliminaryAt && !count.recountStartedAt) throw new StockCountError("recount_required");
    if (count.finalReview) throw new StockCountError("count_not_editable");

    const ingredient = await tx.ingredient.findFirst({
      where: { id: input.ingredientId, restaurantId },
      select: { id: true, active: true, trackInventory: true, measureKind: true, stockLevel: { select: { qtyBase: true, totalValueCents: true } } },
    });
    if (!ingredient) throw new StockCountError("ingredient_not_found", 404);
    if (!ingredient.active) throw new StockCountError("ingredient_inactive");
    if (!ingredient.trackInventory) throw new StockCountError("ingredient_not_tracked");

    const existing = count.items.find((item) => item.ingredientId === ingredient.id);
    if (existing) return { count, itemId: existing.id, added: false };

    const qtyBase = ingredient.stockLevel?.qtyBase ?? 0;
    const recount = !!count.recountStartedAt;
    const item = await tx.stockCountItem.create({
      data: { countId: id, ingredientId: ingredient.id, expectedQty: qtyBase, ...(recount ? { finalExpectedQty: qtyBase } : {}) },
    });
    let recountSnapshot: Snapshot | undefined;
    if (recount) {
      const stored = count.recountSnapshot as Snapshot | null;
      if (stored && Array.isArray(stored.ingredients) && typeof stored.movementCount === "number") {
        const movements = await tx.stockMovement.count({ where: { restaurantId, ingredientId: ingredient.id } });
        recountSnapshot = {
          ...stored,
          movementCount: stored.movementCount + movements,
          ingredients: [...stored.ingredients, {
            id: ingredient.id, trackInventory: ingredient.trackInventory, measureKind: ingredient.measureKind,
            qtyBase, totalValueCents: ingredient.stockLevel?.totalValueCents ?? 0,
          }],
          // Entró después del primer conteo: hay que contarlo.
          ...(stored.recount ? { recount: { ...stored.recount, [ingredient.id]: ["uncounted"] } } : {}),
        };
      }
    }
    await tx.stockCount.update({
      where: { id },
      data: { revision: count.revision + 1, finalReview: Prisma.DbNull, ...(recountSnapshot ? { recountSnapshot } : {}) },
    });
    const updated = await tx.stockCount.findUniqueOrThrow({ where: { id }, include: stockCountInclude });
    return { count: updated, itemId: item.id, added: true };
  }, { timeout: 30_000 });
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
      const owned = new Map(count.items.map((item) => [item.id, item]));
      const changes = input.items ?? [];
      if (!changes.length || new Set(changes.map((item) => item.itemId)).size !== changes.length || changes.some((item) => !owned.has(item.itemId))) throw new StockCountError("invalid", 400);
      // Validate the whole batch before writing, including non-HTTP callers.
      // Older clients omit parts: retain a matching breakdown or normalize it
      // to the changed total, never silently reuse a mismatched breakdown.
      const updates = changes.map((item) => {
        if (!isValidCountQuantity(item.countedQty) || (item.countedParts !== undefined && !isValidCountParts(item.countedQty, item.countedParts))) throw new StockCountError("qty_invalid", 400);
        return { itemId: item.itemId, countedQty: item.countedQty, countedParts: item.countedParts === undefined ? effectiveCountParts(item.countedQty, owned.get(item.itemId)!.countedParts) : [...item.countedParts] };
      });
      for (const item of updates) await tx.stockCountItem.update({ where: { id: item.itemId }, data: { countedQty: item.countedQty, countedParts: item.countedParts } });
      await tx.stockCount.update({ where: { id }, data: common });
    } else if (action === "preliminary") {
      if (count.preliminaryAt) throw new StockCountError("count_changed");
      if (!count.items.some((item) => item.ingredient.trackInventory && item.countedQty !== null)) throw new StockCountError("empty_count", 400);
      for (const item of count.items) await tx.stockCountItem.update({ where: { id: item.id }, data: { preliminaryQty: item.countedQty, preliminaryParts: effectiveCountParts(item.countedQty, item.countedParts) } });
      await tx.stockCount.update({ where: { id }, data: { ...common, preliminaryAt: new Date() } });
    } else if (action === "recount") {
      if (!count.preliminaryAt) throw new StockCountError("preliminary_required");
      const snapshot = await stockSnapshot(tx, restaurantId, count);
      if (!snapshot.ingredients.some((i) => i.trackInventory)) throw new StockCountError("empty_count", 400);
      const levels = new Map(snapshot.ingredients.map((i) => [i.id, i.qtyBase]));
      const tracked = new Set(snapshot.ingredients.filter((i) => i.trackInventory).map((i) => i.id));
      // Insumos con algún movimiento desde que se abrió el conteo. Los
      // movimientos y la apertura del conteo se serializan con el mismo lock,
      // así que `>=` nunca deja por fuera uno posterior (un empate en el mismo
      // milisegundo solo pide recontar de más).
      const moved = new Set((await tx.stockMovement.findMany({
        where: { restaurantId, ingredientId: { in: count.items.map((item) => item.ingredientId) }, createdAt: { gte: count.createdAt } },
        select: { ingredientId: true }, distinct: ["ingredientId"],
      })).map((movement) => movement.ingredientId));
      const full = input.full === true;
      const recount: Record<string, RecountReason[]> = {};
      for (const item of count.items) {
        const liveQty = levels.get(item.ingredientId) ?? 0;
        const reasons = tracked.has(item.ingredientId) ? recountReasons(item, { liveQty, movedSince: moved.has(item.ingredientId) }) : [];
        if (reasons.length) recount[item.ingredientId] = reasons;
        // Se arrastra el primer conteo solo si cuadró y nada se movió: su
        // ajuste es cero por construcción (contado = esperado = saldo de hoy).
        const carried = !full && tracked.has(item.ingredientId) && reasons.length === 0;
        await tx.stockCountItem.update({
          where: { id: item.id },
          data: carried
            ? { countedQty: item.preliminaryQty, countedParts: effectiveCountParts(item.preliminaryQty, item.preliminaryParts), finalExpectedQty: liveQty }
            : { countedQty: null, countedParts: [], finalExpectedQty: liveQty },
        });
      }
      const plan: Snapshot = { ...snapshot, recount, full };
      await tx.stockCount.update({ where: { id }, data: { ...common, recountStartedAt: new Date(), recountSnapshot: plan } });
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
