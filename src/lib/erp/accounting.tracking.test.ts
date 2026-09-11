import { describe, expect, it, vi } from "vitest";
import { buildPnl, splitPurchaseInventoryCost } from "./accounting";
const findOrders = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ db: { purchaseOrder: { findMany: findOrders } } }));
import { loadPurchasesBook } from "./accountingData";

describe("non-stock purchase accounting", () => {
  it.each([
    [10000, 0, 800, 0, 10800],
    [10000, 10000, 800, 10800, 0],
    [10000, 2500, 800, 2700, 8100],
    [3, 1, 2, 2, 3],
    [0, 0, 0, 0, 0],
  ])("splits net %i, nonstock %i and INC %i without losing cents", (receivedCents, nonInventoryReceivedCents, incCents, expenseCents, inventoryCents) => {
    const split = splitPurchaseInventoryCost({ receivedCents, nonInventoryReceivedCents, incCents });
    expect(split).toMatchObject({ expenseCents, inventoryCents });
    expect(split.expenseCents + split.inventoryCents).toBe(receivedCents + incCents);
  });
  it("reduces operating profit once while preserving revenue and inventory cost", () => {
    const result = buildPnl({ salesCents: 10000, tipsCents: 0, taxesCents: 0, consumptionCents: 3000, wasteCents: 0,
      expensesByCategory: [{ category: "", source: "non_inventory_purchases", amountCents: 2000 }], purchasesReceivedCents: 6000 });
    expect(result).toMatchObject({ grossProfitCents: 7000, operatingProfitCents: 5000, expensesCents: 2000 });
    expect(result.expensesByCategory[0].source).toBe("non_inventory_purchases");
  });
  it("uses frozen reception costs, not current ingredient tracking, and allocates INC per invoice", async () => {
    const base = { receivedAt: new Date("2026-09-12"), supplierInvoiceNumber: null, invoiceDueAt: null, paidAt: null, retefuenteCents: 0, reteIvaCents: 0, reteIcaCents: 0, supplier: { name: "Supplier" } };
    findOrders.mockResolvedValue([
      { ...base, id: "a", number: 1, incCents: 2, items: [{ receivedCostCents: 3, nonInventoryReceivedCostCents: 1, nonInventoryReceivedNonDeductibleTaxCents: 0, taxPct: 0 }] },
      { ...base, id: "b", number: 2, incCents: 0, items: [{ receivedCostCents: 1000, nonInventoryReceivedCostCents: 0, nonInventoryReceivedNonDeductibleTaxCents: 0, taxPct: 19 }] },
    ]);
    const result = await loadPurchasesBook("r", { from: new Date("2026-09-01"), to: new Date("2026-10-01") });
    expect(result.totals).toMatchObject({ receivedCents: 1003, nonInventoryReceivedCents: 1, nonInventoryIncCents: 1, ivaCents: 190 });
    const query = findOrders.mock.calls[0][0];
    expect(query.select.items.select.nonInventoryReceivedCostCents).toBe(true);
    expect(query.select.items.select.ingredient).toBeUndefined();
  });
});
