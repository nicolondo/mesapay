import { beforeEach, describe, expect, it, vi } from "vitest";
type TestItem = { id: string; ingredientId: string; expectedQty: number; countedQty: number | null; preliminaryQty: number | null; finalExpectedQty: number | null; ingredient: { id: string; trackInventory: boolean } };
type TestCount = { id: string; restaurantId: string; status: string; revision: number; preliminaryAt: Date | null; recountStartedAt: Date | null; recountSnapshot: unknown; finalReview: { token: string } | null; items: TestItem[] };
type TestIngredient = { id: string; trackInventory: boolean; measureKind: string; stockLevel: { qtyBase: number; totalValueCents: number } | null };
const m = vi.hoisted(() => ({
  count: null! as TestCount,
  ingredients: [] as TestIngredient[],
  movements: 0,
  events: [] as string[],
  apply: vi.fn(),
  lock: vi.fn(),
}));
vi.mock("@/lib/orderLock", () => ({ lockStock: m.lock }));
vi.mock("@/lib/erp/stock", () => ({ applyStockMovement: m.apply }));
vi.mock("@/lib/db", () => {
  const tx = {
    stockCount: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; restaurantId: string } }) => { m.events.push("read"); return m.count?.id === where.id && m.count?.restaurantId === where.restaurantId ? structuredClone(m.count) : null; }),
      update: vi.fn(async ({ data }: { data: Partial<TestCount> }) => { Object.assign(m.count, data); return m.count; }),
      delete: vi.fn(async () => { m.count = null!; }),
      findUniqueOrThrow: vi.fn(async () => structuredClone(m.count)),
    },
    stockCountItem: { update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<TestItem> }) => { Object.assign(m.count.items.find((item) => item.id === where.id)!, data); }) },
    ingredient: { findMany: vi.fn(async () => structuredClone(m.ingredients)) },
    stockMovement: { count: vi.fn(async () => m.movements) },
  };
  return { db: { $transaction: (cb: (t: unknown) => unknown) => cb(tx) } };
});
import { mutateStockCount, sameStockSnapshot } from "./stockCounts";

beforeEach(() => {
  vi.clearAllMocks(); m.events = []; m.movements = 3;
  m.lock.mockImplementation(async () => { m.events.push("lock"); });
  m.count = {
    id: "count", restaurantId: "restaurant", status: "draft", revision: 0,
    preliminaryAt: null, recountStartedAt: null, recountSnapshot: null, finalReview: null,
    items: [{ id: "item", ingredientId: "ingredient", expectedQty: 10000, countedQty: 9000, preliminaryQty: null, finalExpectedQty: null, ingredient: { id: "ingredient", trackInventory: true } }],
  };
  m.ingredients = [{ id: "ingredient", trackInventory: true, measureKind: "mass", stockLevel: { qtyBase: 10000, totalValueCents: 5000 } }];
});
const mutate = (action: Parameters<typeof mutateStockCount>[2], extra: Record<string, unknown> = {}) => mutateStockCount("restaurant", "count", action, { revision: m.count.revision, ...extra });
async function startRecount() { await mutate("preliminary"); await mutate("recount"); }
async function fillReview(qty = 8000) { await mutate("save", { items: [{ itemId: "item", countedQty: qty }] }); return mutate("review"); }

describe("stock count workflow", () => {
  it("locks before reading mutable state", async () => { await mutate("preliminary"); expect(m.events.slice(0, 2)).toEqual(["lock", "read"]); });
  it("preserves the first count, clears final entries and never adjusts before confirmation", async () => {
    await mutate("preliminary"); expect(m.count.items[0].preliminaryQty).toBe(9000);
    await mutate("recount"); expect(m.count.items[0]).toMatchObject({ preliminaryQty: 9000, countedQty: null, finalExpectedQty: 10000 });
    await fillReview(); expect(m.apply).not.toHaveBeenCalled();
    const result = await mutate("close", { reviewToken: m.count.finalReview!.token });
    if (!("count" in result)) throw new Error("expected count");
    const { count, adjustments } = result;
    expect(adjustments).toBe(1); expect(count.status).toBe("closed");
    expect(m.apply).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ qtyBase: -2000, kind: "count_adjust", stockCountId: "count" }), { allowInactive: true });
  });
  it("captures a fresh definitive baseline after sales between first and definitive counts", async () => {
    await mutate("preliminary"); m.ingredients[0].stockLevel!.qtyBase = 7000; m.movements++;
    await mutate("recount"); await fillReview(6000); await mutate("close", { reviewToken: m.count.finalReview!.token });
    expect(m.count.items[0]).toMatchObject({ expectedQty: 10000, preliminaryQty: 9000, finalExpectedQty: 7000, countedQty: 6000 });
    expect(m.apply.mock.calls[0][1].qtyBase).toBe(-1000);
  });
  it("requires recount before editing a published preliminary", async () => { await mutate("preliminary"); await expect(mutate("save", { items: [{ itemId: "item", countedQty: 1 }] })).rejects.toMatchObject({ code: "recount_required" }); });
  it("requires preliminary before recount", async () => { await expect(mutate("recount")).rejects.toMatchObject({ code: "preliminary_required" }); });
  it("rejects empty first counts, treating zero as counted", async () => { m.count.items[0].countedQty = null; await expect(mutate("preliminary")).rejects.toMatchObject({ code: "empty_count" }); m.count.items[0].countedQty = 0; await mutate("preliminary"); expect(m.count.items[0].preliminaryQty).toBe(0); });
  it("cannot freeze the preliminary twice", async () => { await mutate("preliminary"); await expect(mutate("preliminary")).rejects.toMatchObject({ code: "count_changed" }); });
  it("requires every tracked entry to be recounted", async () => { await startRecount(); await expect(mutate("review")).rejects.toMatchObject({ code: "incomplete_count" }); });
  it("allows definitive zero", async () => { await startRecount(); await fillReview(0); await mutate("close", { reviewToken: m.count.finalReview!.token }); expect(m.apply.mock.calls[0][1].qtyBase).toBe(-10000); });
  it("adds a definitive surplus using the reviewed quantity", async () => { await startRecount(); await fillReview(11500); await mutate("close", { reviewToken: m.count.finalReview!.token }); expect(m.apply.mock.calls[0][1].qtyBase).toBe(1500); });
  it("rejects adjustments beyond the inventory movement limit before review", async () => { m.ingredients[0].stockLevel!.qtyBase = -1; await startRecount(); await mutate("save", { items: [{ itemId: "item", countedQty: 2_000_000_000 }] }); await expect(mutate("review")).rejects.toMatchObject({ code: "qty_invalid", status: 400 }); expect(m.apply).not.toHaveBeenCalled(); });
  it("does not create empty adjustments when stock matches", async () => { await startRecount(); await fillReview(10000); const result = await mutate("close", { reviewToken: m.count.finalReview!.token }); if (!("count" in result)) throw new Error("expected count"); expect(result.adjustments).toBe(0); expect(m.apply).not.toHaveBeenCalled(); });
  it("requires a matching persisted final review token", async () => { await startRecount(); await fillReview(); await expect(mutate("close", { reviewToken: "other" })).rejects.toMatchObject({ code: "review_required" }); expect(m.apply).not.toHaveBeenCalled(); });
  it("invalidates the review after any edit", async () => { await startRecount(); await fillReview(); const token = m.count.finalReview!.token; await mutate("save", { items: [{ itemId: "item", countedQty: 7500 }] }); await expect(mutate("close", { reviewToken: token })).rejects.toMatchObject({ code: "review_required" }); });
  it("rejects stale revision before writing", async () => { await mutate("preliminary"); await expect(mutate("recount", { revision: 0 })).rejects.toMatchObject({ code: "count_changed" }); expect(m.count.recountStartedAt).toBeNull(); });
  it("rejects edits and repeated closure after close", async () => { await startRecount(); await fillReview(); const token = m.count.finalReview!.token; await mutate("close", { reviewToken: token }); await expect(mutate("save", { items: [{ itemId: "item", countedQty: 2 }] })).rejects.toMatchObject({ code: "already_closed" }); await expect(mutate("close", { reviewToken: token })).rejects.toMatchObject({ code: "already_closed" }); expect(m.apply).toHaveBeenCalledTimes(1); });
  it.each(["qty", "value", "movement", "tracking", "unit"])("rejects stock %s changes even with a review token", async (change) => {
    await startRecount(); await fillReview();
    if (change === "qty") m.ingredients[0].stockLevel!.qtyBase--;
    if (change === "value") m.ingredients[0].stockLevel!.totalValueCents--;
    if (change === "movement") m.movements += 2;
    if (change === "tracking") m.ingredients[0].trackInventory = false;
    if (change === "unit") m.ingredients[0].measureKind = "volume";
    await expect(mutate("close", { reviewToken: m.count.finalReview!.token })).rejects.toMatchObject({ code: "stock_changed" }); expect(m.apply).not.toHaveBeenCalled();
  });
  it("cannot regenerate a review after stock changed without restarting recount", async () => { await startRecount(); await fillReview(); m.movements++; await expect(mutate("review")).rejects.toMatchObject({ code: "stock_changed" }); await mutate("recount"); expect(m.count.items[0].countedQty).toBeNull(); expect(m.count.items[0].preliminaryQty).toBe(9000); await fillReview(); });
  it("does not disclose a different restaurant's count", async () => { await expect(mutateStockCount("other", "count", "delete", { revision: 0 })).rejects.toMatchObject({ code: "not_found", status: 404 }); expect(m.count).not.toBeNull(); });
  it("rejects foreign and duplicate item IDs atomically", async () => { for (const items of [[{ itemId: "other", countedQty: 1 }], [{ itemId: "item", countedQty: 1 }, { itemId: "item", countedQty: 2 }]]) await expect(mutate("save", { items })).rejects.toMatchObject({ code: "invalid" }); expect(m.count.items[0].countedQty).toBe(9000); });
  it("can discard any unclosed phase", async () => { await startRecount(); await fillReview(); expect(await mutate("delete")).toEqual({ ok: true }); expect(m.count).toBeNull(); expect(m.apply).not.toHaveBeenCalled(); });
  it("excludes non-inventariable entries from the definitive completeness check", async () => {
    m.count.items.push({ id: "item2", ingredientId: "ingredient2", expectedQty: 0, countedQty: null, preliminaryQty: null, finalExpectedQty: null, ingredient: { id: "ingredient2", trackInventory: false } });
    m.ingredients.push({ id: "ingredient2", trackInventory: false, measureKind: "count", stockLevel: null });
    await startRecount(); await fillReview(); await mutate("close", { reviewToken: m.count.finalReview!.token }); expect(m.apply).toHaveBeenCalledTimes(1);
  });
  it("compares snapshots independently of JSONB object key order", () => {
    expect(sameStockSnapshot({ movementCount: 1, ingredients: [{ id: "a", trackInventory: true, qtyBase: 3, totalValueCents: 4 }] }, { ingredients: [{ totalValueCents: 4, qtyBase: 3, trackInventory: true, id: "a" }], movementCount: 1 })).toBe(true);
    expect(sameStockSnapshot(null, {})).toBe(false); expect(sameStockSnapshot({}, {})).toBe(false);
  });
});
