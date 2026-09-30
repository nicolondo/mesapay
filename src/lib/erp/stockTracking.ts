import type { MeasureKind, Prisma } from "@prisma/client";
import { lockStock } from "@/lib/orderLock";

export type StockResetSnapshot = {
  qtyBase: number;
  totalValueCents: number;
  updatedAt: string | null;
  ingredientUpdatedAt: string;
  movementCount: number;
  measureKind: MeasureKind;
};

type DisableResult = { ok: true } | { error: "not_found" } | {
  error: "inventory_balance_remaining" | "stock_reset_conflict";
  stockReset: StockResetSnapshot;
};

function sameSnapshot(a: StockResetSnapshot, b: StockResetSnapshot) {
  return a.qtyBase === b.qtyBase && a.totalValueCents === b.totalValueCents &&
    a.updatedAt === b.updatedAt && a.ingredientUpdatedAt === b.ingredientUpdatedAt &&
    a.movementCount === b.movementCount && a.measureKind === b.measureKind;
}

/**
 * Specialized stock writer for an explicitly reviewed tracking disable.
 * Unlike normal average-cost movements, this must cancel both stored balances
 * exactly, including negative stock and value remaining at zero quantity.
 * Call inside a transaction: the ledger, zero balances and tracking flag commit
 * together. The shared restaurant lock also serializes sales/counts/purchases.
 */
export async function disableInventoryTracking(
  tx: Prisma.TransactionClient,
  args: { restaurantId: string; ingredientId: string; createdById: string | null; resetStock?: StockResetSnapshot },
): Promise<DisableResult> {
  const { restaurantId, ingredientId, createdById, resetStock } = args;
  await lockStock(tx, restaurantId);
  const ingredient = await tx.ingredient.findUnique({ where: { id: ingredientId } });
  if (!ingredient || ingredient.restaurantId !== restaurantId) return { error: "not_found" };
  const level = await tx.stockLevel.findUnique({ where: { ingredientId } });
  if (level && level.restaurantId !== restaurantId) return { error: "not_found" };
  const qtyBase = level?.qtyBase ?? 0;
  const totalValueCents = level?.totalValueCents ?? 0;
  const hasBalance = qtyBase !== 0 || totalValueCents !== 0;
  // Successful retries must not append another adjustment or invalidate their
  // original confirmation merely because the first request updated timestamps.
  if (!ingredient.trackInventory && !hasBalance) return { ok: true };
  const stockReset: StockResetSnapshot = {
    qtyBase, totalValueCents, updatedAt: level?.updatedAt.toISOString() ?? null,
    ingredientUpdatedAt: ingredient.updatedAt.toISOString(), measureKind: ingredient.measureKind,
    movementCount: await tx.stockMovement.count({ where: { restaurantId, ingredientId } }),
  };
  if (resetStock && !sameSnapshot(resetStock, stockReset)) return { error: "stock_reset_conflict", stockReset };
  if (hasBalance && !resetStock) return { error: "inventory_balance_remaining", stockReset };
  if (hasBalance) {
    // INT_MIN has no positive INT4 inverse. At that single boundary append
    // two representable parts; their exact sum still cancels the old balance.
    const reverseQty = -qtyBase;
    const reverseValue = -totalValueCents;
    const max = 2_147_483_647;
    const firstQty = Math.min(reverseQty, max);
    const firstValue = Math.min(reverseValue, max);
    const parts = [[firstQty, firstValue], [reverseQty - firstQty, reverseValue - firstValue]];
    for (const [qty, value] of parts) {
      if (qty === 0 && value === 0) continue;
      await tx.stockMovement.create({ data: {
        restaurantId, ingredientId,
        kind: (qty || value) > 0 ? "adjust_in" : "adjust_out",
        qtyBase: qty, valueCents: value, note: "inventory_tracking_disabled", createdById,
      } });
    }
    await tx.stockLevel.update({ where: { ingredientId }, data: { qtyBase: 0, totalValueCents: 0 } });
  }
  await tx.ingredient.update({
    where: { id: ingredientId, restaurantId },
    data: { trackInventory: false, reorderPointBase: null, reorderQtyBase: null },
  });
  return { ok: true };
}
