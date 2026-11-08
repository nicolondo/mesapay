import { describe, expect, it } from "vitest";
import { purchaseCostFromAggregate, type PurchaseCostAggregate } from "./purchaseCost";

const at = (value: string) => new Date(`${value}T12:00:00Z`);
const row = (extra: Partial<PurchaseCostAggregate> = {}): PurchaseCostAggregate => ({
  ingredientId: "ingredient", purchaseOrderId: "purchase", purchaseOrderNumber: 12,
  supplierName: "Supplier", status: "received", createdAt: at("2026-10-01"),
  orderReceivedAt: at("2026-10-05"), lastReceivedAt: null,
  movementReceivedAt: null, qtyBase: BigInt(2000), netCents: BigInt(2000000),
  nonInventoryNetCents: BigInt(2000000), nonInventoryVatCents: BigInt(380000),
  nonInventoryIncCents: BigInt(100000), movementQtyBase: BigInt(0), movementValueCents: BigInt(0),
  invalidLines: false, invalidMovements: false, ...extra,
});

describe("cost of a received purchase, independent of stock and manual prices", () => {
  it("recovers the actual non-stock cost including frozen non-deductible VAT and consumption tax", () => {
    expect(purchaseCostFromAggregate(row())).toEqual({
      purchaseOrderId: "purchase", purchaseOrderNumber: 12, supplierName: "Supplier",
      qtyBase: 2000, totalCostCents: 2480000, costPerBase: 1240,
      receivedAt: "2026-10-05T12:00:00.000Z", dateBasis: "order_received",
    });
  });

  it("does not add deductible VAT or subtract supplier payment retentions", () => {
    expect(purchaseCostFromAggregate(row({ nonInventoryVatCents: BigInt(0), nonInventoryIncCents: BigInt(0) })))
      .toMatchObject({ totalCostCents: 2000000, costPerBase: 1000 });
  });

  it("uses ledger valuation for tracked receipts and combines tracking changes without double-counting", () => {
    expect(purchaseCostFromAggregate(row({
      nonInventoryNetCents: BigInt(0), nonInventoryVatCents: BigInt(0), nonInventoryIncCents: BigInt(0),
      movementQtyBase: BigInt(2000), movementValueCents: BigInt(2380000),
    }))).toMatchObject({ totalCostCents: 2380000, costPerBase: 1190 });
    expect(purchaseCostFromAggregate(row({
      nonInventoryNetCents: BigInt(1000000), nonInventoryVatCents: BigInt(190000),
      nonInventoryIncCents: BigInt(50000), movementQtyBase: BigInt(1000), movementValueCents: BigInt(1240000),
    }))).toMatchObject({ totalCostCents: 2480000, costPerBase: 1240 });
  });

  it("retains fractional unit cost until recipe-line rounding and accepts explicit free receipts", () => {
    expect(purchaseCostFromAggregate(row({ qtyBase: BigInt(3000), netCents: BigInt(100), nonInventoryNetCents: BigInt(100), nonInventoryVatCents: BigInt(0), nonInventoryIncCents: BigInt(0) })))
      .toMatchObject({ totalCostCents: 100, costPerBase: 100 / 3000 });
    expect(purchaseCostFromAggregate(row({ netCents: BigInt(0), nonInventoryNetCents: BigInt(0), nonInventoryVatCents: BigInt(0), nonInventoryIncCents: BigInt(0) })))
      .toMatchObject({ totalCostCents: 0, costPerBase: 0 });
  });

  it("uses the new line receipt timestamp for partial purchases", () => {
    expect(purchaseCostFromAggregate(row({ status: "partially_received", orderReceivedAt: null, lastReceivedAt: at("2026-10-09") })))
      .toMatchObject({ receivedAt: "2026-10-09T12:00:00.000Z", dateBasis: "line_received" });
  });

  it("dates fully tracked legacy partials from receipt movements", () => {
    expect(purchaseCostFromAggregate(row({
      status: "partially_received", orderReceivedAt: null, movementReceivedAt: at("2026-10-08"),
      movementQtyBase: BigInt(2000), movementValueCents: BigInt(2000000),
      nonInventoryNetCents: BigInt(0), nonInventoryVatCents: BigInt(0), nonInventoryIncCents: BigInt(0),
    }))).toMatchObject({ receivedAt: "2026-10-08T12:00:00.000Z", dateBasis: "stock_movement" });
  });

  it("explicitly labels the documentary date for legacy non-stock or mixed partial receipts", () => {
    expect(purchaseCostFromAggregate(row({ status: "partially_received", orderReceivedAt: null })))
      .toMatchObject({ receivedAt: "2026-10-01T12:00:00.000Z", dateBasis: "order_created" });
    expect(purchaseCostFromAggregate(row({
      status: "partially_received", orderReceivedAt: null, movementReceivedAt: at("2026-10-08"),
      movementQtyBase: BigInt(1000), movementValueCents: BigInt(1000000),
      nonInventoryNetCents: BigInt(1000000), nonInventoryVatCents: BigInt(0), nonInventoryIncCents: BigInt(0),
    }))).toMatchObject({ receivedAt: "2026-10-01T12:00:00.000Z", dateBasis: "order_created" });
  });

  it.each(["draft", "sent", "canceled"])("does not cost %s orders even if inconsistent receipt fields are present", (status) => {
    expect(purchaseCostFromAggregate(row({ status }))).toBeNull();
  });

  it.each([
    { qtyBase: BigInt(0) }, { qtyBase: -BigInt(1) }, { qtyBase: BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1) },
    { netCents: -BigInt(1) }, { nonInventoryNetCents: -BigInt(1) }, { nonInventoryVatCents: -BigInt(1) },
    { nonInventoryIncCents: -BigInt(1) }, { movementQtyBase: -BigInt(1) }, { movementValueCents: -BigInt(1) },
    { nonInventoryNetCents: BigInt(2000001) }, { movementQtyBase: BigInt(2001) },
    { movementQtyBase: BigInt(2000), movementValueCents: BigInt(2000000) },
    { movementValueCents: BigInt(1) },
    { invalidLines: true }, { invalidMovements: true },
    { nonInventoryNetCents: BigInt(0) },
    { nonInventoryNetCents: BigInt(1000000), movementQtyBase: BigInt(1000), movementValueCents: BigInt(999999) },
    { netCents: BigInt(Number.MAX_SAFE_INTEGER), nonInventoryNetCents: BigInt(Number.MAX_SAFE_INTEGER) },
    { lastReceivedAt: new Date("invalid") }, { createdAt: new Date("invalid") },
  ] satisfies Partial<PurchaseCostAggregate>[])("rejects inconsistent evidence instead of manufacturing a cheap cost (case %#)", (extra) => {
    expect(purchaseCostFromAggregate(row(extra))).toBeNull();
  });
});
