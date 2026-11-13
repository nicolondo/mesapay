import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PurchaseCostDTO } from "./purchaseCost";

const m = vi.hoisted(() => ({ ingredients: vi.fn(), purchases: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { ingredient: { findMany: m.ingredients } } }));
vi.mock("@/lib/erp/purchaseCostData", () => ({ loadPurchaseCosts: m.purchases }));
import { loadCostContext, loadIngredientCostViews } from "./recipeData";

const purchase: PurchaseCostDTO = {
  purchaseOrderId: "po", purchaseOrderNumber: 3, supplierName: "Supplier",
  qtyBase: 2000, totalCostCents: 1000000, costPerBase: 500,
  receivedAt: "2026-10-01T12:00:00.000Z", dateBasis: "order_received",
};
const ingredient = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: id, measureKind: "mass", active: true, trackInventory: false,
  referencePriceCents: null, stockLevel: null, supplierItems: [], recipe: null, ...extra,
});

beforeEach(() => {
  vi.resetAllMocks();
  m.ingredients.mockResolvedValue([ingredient("purchased"), ingredient("missing"), ingredient("manual", { referencePriceCents: 0 })]);
  m.purchases.mockResolvedValue(new Map([["purchased", purchase], ["manual", purchase]]));
});

describe("purchase cost integration in the shared recipe context", () => {
  it("loads tenant-owned ingredients and their purchase evidence once without editing their manual prices", async () => {
    const { ctx, meta, purchaseCosts } = await loadCostContext("restaurant");
    expect(m.ingredients).toHaveBeenCalledWith(expect.objectContaining({ where: { restaurantId: "restaurant" } }));
    expect(m.purchases).toHaveBeenCalledExactlyOnceWith("restaurant", ["purchased", "missing", "manual"]);
    expect(ctx.get("purchased")).toMatchObject({ referencePriceCents: null, purchase });
    expect(ctx.get("missing")).toMatchObject({ referencePriceCents: null, purchase: null });
    expect(ctx.get("manual")).toMatchObject({ referencePriceCents: 0, purchase });
    expect(meta.get("purchased")).toMatchObject({ trackInventory: false });
    expect(purchaseCosts.get("purchased")).toBe(purchase);
  });

  it("returns the same effective cost as recipes and keeps provenance separate from the selected source", async () => {
    const result = await loadIngredientCostViews("restaurant");
    expect(result.get("purchased")).toEqual({ costPerBase: 500, costSource: "purchase", purchaseCost: purchase });
    expect(result.get("missing")).toEqual({ costPerBase: null, costSource: null, purchaseCost: null });
    expect(result.get("manual")).toEqual({ costPerBase: 0, costSource: "reference", purchaseCost: purchase });
  });

  it("keeps positive stock, subrecipes and the supplier list available to the existing cascade", async () => {
    m.ingredients.mockResolvedValue([
      ingredient("stock", { stockLevel: { qtyBase: 2000, totalValueCents: 2000000 } }),
      ingredient("listed", { supplierItems: [{ contentQty: 1000, lastPriceCents: 100000 }] }),
      ingredient("prepared", { recipe: { outputQtyBase: 1000, items: [{ ingredientId: "listed", qtyBase: 100, wastePct: 0 }] } }),
    ]);
    m.purchases.mockResolvedValue(new Map());
    const result = await loadIngredientCostViews("restaurant");
    expect(result.get("stock")).toMatchObject({ costPerBase: 1000, costSource: "stock" });
    expect(result.get("listed")).toMatchObject({ costPerBase: 100, costSource: "supplier" });
    expect(result.get("prepared")).toMatchObject({ costPerBase: 10, costSource: "subrecipe" });
  });

  it("returns an empty catalog without manufacturing purchase records", async () => {
    m.ingredients.mockResolvedValue([]);
    m.purchases.mockResolvedValue(new Map());
    expect(await loadIngredientCostViews("empty")).toEqual(new Map());
    expect(m.purchases).toHaveBeenCalledExactlyOnceWith("empty", []);
  });
});
