import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PurchaseCostAggregate } from "./purchaseCost";

const query = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ db: { $queryRaw: query } }));
import { loadPurchaseCosts, purchaseCostQuery } from "./purchaseCostData";

const row: PurchaseCostAggregate = {
  ingredientId: "ingredient", purchaseOrderId: "po", purchaseOrderNumber: 5,
  supplierName: "Supplier", status: "received", createdAt: new Date("2026-10-01T12:00:00Z"),
  orderReceivedAt: new Date("2026-10-02T12:00:00Z"), lastReceivedAt: null, movementReceivedAt: null,
  qtyBase: BigInt(1000), netCents: BigInt(10000), nonInventoryNetCents: BigInt(10000),
  nonInventoryVatCents: BigInt(1900), nonInventoryIncCents: BigInt(0),
  movementQtyBase: BigInt(0), movementValueCents: BigInt(0), invalidLines: false, invalidMovements: false,
};

beforeEach(() => { query.mockReset(); });

describe("received purchase cost data boundary", () => {
  it("uses one query and omits inconsistent evidence instead of supplying an invented cost", async () => {
    query.mockResolvedValue([row, { ...row, ingredientId: "missing-ledger", nonInventoryNetCents: BigInt(0) }]);
    const costs = await loadPurchaseCosts("restaurant");
    expect(query).toHaveBeenCalledTimes(1);
    expect([...costs.keys()]).toEqual(["ingredient"]);
    expect(costs.get("ingredient")).toMatchObject({ totalCostCents: 11900, costPerBase: 11.9, dateBasis: "order_received" });
  });

  it("parameterizes tenant and ingredient filters without interpolating executable input", async () => {
    const id = "' OR 1=1 --";
    query.mockResolvedValue([]);
    await loadPurchaseCosts(id, [id]);
    const sql = query.mock.calls[0][0];
    expect(sql.text).not.toContain(id);
    expect(sql.values).toContain(id);
    expect(sql.text).not.toContain('"updatedAt"');
  });

  it("does no database work for an empty catalog and keeps an empty diagnostic filter restrictive", async () => {
    expect(await loadPurchaseCosts("restaurant", [])).toEqual(new Map());
    expect(query).not.toHaveBeenCalled();
    expect(purchaseCostQuery("restaurant", []).text).toContain("AND false");
  });

  it("surfaces a failed query rather than pretending an empty or free purchase history", async () => {
    query.mockRejectedValue(new Error("Database unavailable"));
    await expect(loadPurchaseCosts("restaurant")).rejects.toThrow("Database unavailable");
  });
});
