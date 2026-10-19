import { describe, expect, it } from "vitest";
import { initialInvoicePrice, invoiceLineAmounts, parseInvoiceTaxPct } from "./invoiceAmounts";

describe("invoice amounts are totals, with explicit tax basis", () => {
  it("parses printed VAT rates without silently treating an unreadable rate as exempt", () => {
    for (const input of ["5", "5%", " 5 % ", "5,0 %"]) expect(parseInvoiceTaxPct(input)).toBe(5);
    expect(parseInvoiceTaxPct("0")).toBe(0);
    for (const input of [null, undefined, "", "ilegible", "IVA 5 / 19", "5.5%", "101", "-1", "1e2"]) expect(parseInvoiceTaxPct(input)).toBeNull();
  });
  it("keeps two bottles at 138,850, including consumption and VAT", () => {
    expect(invoiceLineAmounts({ amountCents: 13885000, amountKind: "line", quantity: 2, taxBasis: "gross", taxPct: 5, incCents: 4977400 }))
      .toEqual({ netCents: 8483429, taxCents: 424171, incCents: 4977400, totalCents: 13885000 });
  });
  it("multiplies an explicitly unit price exactly once", () => {
    expect(invoiceLineAmounts({ amountCents: 6942500, amountKind: "unit", quantity: 2, taxBasis: "gross", taxPct: 5, incCents: 4977400 })?.totalCents).toBe(13885000);
  });
  it("preserves the exact gross cent even when net × rate would round differently", () => {
    expect(invoiceLineAmounts({ amountCents: 13885000, amountKind: "line", quantity: 2, taxBasis: "gross", taxPct: 5 }))
      .toEqual({ netCents: 13223810, taxCents: 661190, incCents: 0, totalCents: 13885000 });
  });
  it("uses a transcribed VAT amount without adding it again", () => {
    expect(invoiceLineAmounts({ amountCents: 13885000, amountKind: "line", quantity: 2, taxBasis: "gross", taxPct: 5, taxCents: 424200, incCents: 4977400 }))
      .toEqual({ netCents: 8483400, taxCents: 424200, incCents: 4977400, totalCents: 13885000 });
  });
  it("adds VAT and consumption once to a net total", () => {
    expect(invoiceLineAmounts({ amountCents: 8483400, amountKind: "line", quantity: 2, taxBasis: "net", taxPct: 5, taxCents: 424200, incCents: 4977400 })?.totalCents).toBe(13885000);
  });
  it("reconciles the nine printed final totals without adding consumption or VAT twice", () => {
    const rows = [
      [1, 6492100, 5, 1438600], [2, 4258100, 19, 0],
      [2, 13885000, 5, 4977400], [2, 4260000, 19, 0],
      [2, 17307900, 5, 4213800], [4, 5513400, 19, 0],
      [2, 69980000, 5, 16978800], [4, 10138100, 5, 3055600],
      [4, 10137900, 5, 3108000],
    ];
    const totals = rows.map(([quantity, amountCents, taxPct, incCents]) =>
      invoiceLineAmounts({ quantity, amountCents, taxPct, incCents, amountKind: "line", taxBasis: "gross" })!);
    expect(totals.reduce((sum, line) => sum + line.totalCents, 0)).toBe(141972500);
    expect(totals.reduce((sum, line) => sum + line.incCents, 0)).toBe(33772200);
    expect(totals.reduce((sum, line) => sum + line.netCents + line.taxCents + line.incCents, 0)).toBe(141972500);
  });
  it("preserves decimals and supports fractional quantities and zero-priced lines", () => {
    expect(invoiceLineAmounts({ amountCents: 12345, amountKind: "unit", quantity: 2.5, taxBasis: "net", taxPct: 19 }))
      .toEqual({ netCents: 30863, taxCents: 5864, incCents: 0, totalCents: 36727 });
    expect(invoiceLineAmounts({ amountCents: 0, amountKind: "line", quantity: 2, taxBasis: "net", taxPct: 0 })?.totalCents).toBe(0);
  });
  it("never guesses the tax basis of old/ambiguous extractions", () => {
    expect(invoiceLineAmounts({ amountCents: 13885000, amountKind: "line", quantity: 2, taxBasis: "unknown", taxPct: 5 })).toBeNull();
    expect(initialInvoicePrice({ quantity: 2, unitPriceCents: 4241700, lineTotalCents: 13885000 })).toMatchObject({ cost: "138850", amountKind: "line", taxBasis: "unknown", incNeedsReview: true });
  });
  it("prefers the explicit total over unit × quantity even with different tax bases", () => {
    expect(initialInvoicePrice({ quantity: 2, unitPriceCents: 4241700, unitPriceTaxBasis: "net", lineTotalCents: 13885000, lineTotalTaxBasis: "gross", lineIncCents: 4977400, lineTotalLabel: "VLR NETO FINAL" }))
      .toMatchObject({ cost: "138850", amountKind: "line", taxBasis: "gross", incAmount: "49774", taxAmount: "", amountLabel: "VLR NETO FINAL" });
  });
  it("keeps a unit-only amount as unit and preserves transcribed cents", () => {
    expect(initialInvoicePrice({ quantity: 2, unitPriceCents: 6942550, unitPriceTaxBasis: "gross", lineTotalCents: null }))
      .toMatchObject({ cost: "69425.5", amountKind: "unit", taxBasis: "gross" });
    expect(initialInvoicePrice({ quantity: 1, unitPriceCents: null, lineTotalCents: null }).cost).toBe("");
  });
  it.each([
    { amountCents: -1 }, { amountCents: NaN }, { amountCents: 1.5 },
    { taxPct: -1 }, { taxPct: 101 }, { taxPct: NaN },
    { incCents: -1 }, { incCents: 200 }, { taxCents: 200 },
    { taxCents: -1 }, { taxCents: 1.5 }, { quantity: 0 },
    { amountKind: "unit" as const, quantity: 100000000 },
  ])("rejects invalid or impossible invoice amounts: %j", (invalid) => {
    expect(invoiceLineAmounts({ amountCents: 100, amountKind: "line", quantity: 1, taxBasis: "gross", taxPct: 5, ...invalid })).toBeNull();
  });
});
