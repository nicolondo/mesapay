import { describe, expect, it } from "vitest";
import {
  poTotals,
  purchaseLineAmounts,
  purchaseOrderTotals,
  receivedPurchaseLineAmounts,
  expectedReceiptCostCents,
  lineTaxCents,
  lineGrossCents,
  inventoryCostCents,
  purchaseTaxRates,
  invoiceGrandTotalCents,
  normalizeTaxPct,
  totalsMatch,
} from "./purchaseTax";

const gordons = {
  expectedCostCents: 8_483_400,
  expectedTaxCents: 424_200,
  expectedIncCents: 4_977_400,
  taxPct: 5,
  qtyOrderedBase: 2_000,
  receivedCostCents: 8_483_400,
  receivedQtyBase: 2_000,
};

describe("documentary purchase amounts", () => {
  it("suggests three partial net receipts without losing cents or compensating earlier manual prices", () => {
    const item = { expectedCostCents: 10, qtyOrderedBase: 3, receivedQtyBase: 0, receivedCostCents: 0 };
    expect([0, 1, 2].map((receivedQtyBase) => expectedReceiptCostCents({ ...item, receivedQtyBase }, 1))).toEqual([3, 4, 3]);
    const manuallyPriced = { ...item, receivedQtyBase: 1, receivedCostCents: 99 };
    expect(expectedReceiptCostCents(manuallyPriced, 1)).toBe(4);
  });
  it("preserves the supplier's exact two-bottle gross, without multiplying line totals", () => {
    expect(purchaseLineAmounts(gordons)).toEqual({
      netCents: 8_483_400, taxCents: 424_200, incCents: 4_977_400, totalCents: 13_885_000,
    });
    expect(purchaseOrderTotals({ items: [gordons], incCents: 4_977_400 })).toMatchObject({
      subtotalCents: 8_483_400, taxCents: 424_200, incCents: 4_977_400, totalCents: 13_885_000,
    });
  });

  it("uses explicit zero VAT and retains percentage fallback only for missing overrides", () => {
    expect(poTotals([{ costCents: 10_000, taxPct: 19, taxCents: 0 }])).toEqual({
      subtotalCents: 10_000, taxCents: 0, totalCents: 10_000,
    });
    expect(poTotals([{ costCents: 10_000, taxPct: 19, taxCents: null }]).taxCents).toBe(1_900);
    expect(purchaseLineAmounts({ expectedCostCents: 10_000, taxPct: 19, qtyOrderedBase: 1_000 })).toEqual({
      netCents: 10_000, taxCents: 1_900, incCents: 0, totalCents: 11_900,
    });
  });

  it("allocates consumption by units and VAT by received net cost", () => {
    expect(purchaseLineAmounts(gordons, 4_000_000, 1_000)).toEqual({
      netCents: 4_000_000, taxCents: 200_014, incCents: 2_488_700, totalCents: 6_688_714,
    });
    expect(receivedPurchaseLineAmounts({ ...gordons, receivedCostCents: 0, receivedQtyBase: 0 })).toEqual({
      netCents: 0, taxCents: 0, incCents: 0, totalCents: 0,
    });
  });

  it("rounds cumulative partial amounts to the exact final invoice", () => {
    const item = { expectedCostCents: 3, expectedTaxCents: 2, expectedIncCents: 2, taxPct: 19, qtyOrderedBase: 3 };
    const cumulative = [0, 1, 2, 3].map((n) => purchaseLineAmounts(item, n, n));
    const changes = cumulative.slice(1).map((a, i) => ({ tax: a.taxCents - cumulative[i].taxCents, inc: a.incCents - cumulative[i].incCents }));
    expect(changes).toEqual([{ tax: 1, inc: 1 }, { tax: 0, inc: 0 }, { tax: 1, inc: 1 }]);
    expect(cumulative[3].totalCents).toBe(7);
  });

  it("scales explicit tax safely near integer-column limits", () => {
    expect(purchaseLineAmounts({ expectedCostCents: 1_999_999_999, expectedTaxCents: 1_999_999_997, taxPct: 100, qtyOrderedBase: 1 }, 1_999_999_998, 1).taxCents).toBe(1_999_999_996);
  });

  it("adds only unallocated header consumption and subtracts retentions once", () => {
    const po = { items: [gordons], incCents: 4_977_500, retefuenteCents: 100, reteIvaCents: 50, reteIcaCents: 25 };
    expect(purchaseOrderTotals(po)).toMatchObject({ incCents: 4_977_500, retentionsCents: 175, totalCents: 13_884_925 });
    expect(purchaseOrderTotals(po, "received")).toEqual(purchaseOrderTotals(po));
  });

  it("does not charge the unreceived part of a documentary consumption or retention", () => {
    const po = { items: [{ ...gordons, receivedCostCents: 4_241_700, receivedQtyBase: 1_000 }], incCents: 4_977_600, retefuenteCents: 100 };
    expect(purchaseOrderTotals(po, "received")).toMatchObject({ subtotalCents: 4_241_700, taxCents: 212_100, incCents: 2_488_800, retentionsCents: 50, totalCents: 6_942_550 });
  });

  it("keeps legacy invoices using the same percentage and header amounts", () => {
    const po = { items: [{ expectedCostCents: 10_000, receivedCostCents: 10_000, qtyOrderedBase: 1_000, receivedQtyBase: 1_000, taxPct: 19 }], incCents: 800, retefuenteCents: 100 };
    expect(purchaseOrderTotals(po, "received")).toMatchObject({ subtotalCents: 10_000, taxCents: 1_900, incCents: 800, totalCents: 12_600 });
  });

  it("keeps percentage-only clients and deductible/non-deductible legacy costs compatible", () => {
    expect(lineTaxCents(100_001, 19)).toBe(19_000);
    expect(lineGrossCents(100_001, 19)).toBe(119_001);
    expect(inventoryCostCents(100_001, 19, false)).toBe(119_001);
    expect(inventoryCostCents(100_001, 19, true)).toBe(100_001);
    expect(invoiceGrandTotalCents(100_001, 19_000, { incCents: 800, retefuenteCents: 100, reteIvaCents: 50, reteIcaCents: 25 })).toBe(119_626);
  });

  it("retains country tariffs and rejects invalid percentage inputs", () => {
    expect(purchaseTaxRates("MX")).toEqual([0, 8, 16]);
    expect(purchaseTaxRates("CO")).toEqual([0, 5, 19]);
    expect(normalizeTaxPct("19")).toBe(19);
    expect(normalizeTaxPct(5)).toBe(5);
    expect(normalizeTaxPct(-1)).toBe(0);
    expect(normalizeTaxPct(101)).toBe(0);
    expect(normalizeTaxPct(Number.NaN)).toBe(0);
  });

  it("preserves legacy comparison tolerance without treating an unknown total as zero", () => {
    expect(totalsMatch(1_000_000, null)).toBe(true);
    expect(totalsMatch(1_000_000, 1_000_001)).toBe(true);
    expect(totalsMatch(1_000_000, 1_009_000)).toBe(true);
    expect(totalsMatch(1_000_000, 1_020_000)).toBe(false);
  });

  it("handles free lines, zero receipts, and old projections without quantities", () => {
    const free = { expectedCostCents: 0, expectedTaxCents: 0, expectedIncCents: 20, taxPct: 0, qtyOrderedBase: 2, receivedCostCents: 0, receivedQtyBase: 1 };
    expect(purchaseOrderTotals({ items: [free], incCents: 40 }, "received").totalCents).toBe(20);
    expect(purchaseOrderTotals({ items: [] }, "received").totalCents).toBe(0);
    expect(purchaseOrderTotals({ items: [{ receivedCostCents: 1_000, taxPct: 19 }], incCents: 50 }, "received").totalCents).toBe(1_240);
    expect(purchaseLineAmounts({ taxPct: 0 })).toMatchObject({ totalCents: 0 });
    expect(receivedPurchaseLineAmounts({ taxPct: 0 })).toMatchObject({ totalCents: 0 });
    expect(expectedReceiptCostCents({}, 0)).toBe(0);
  });
});
