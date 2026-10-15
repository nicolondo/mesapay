import { describe, expect, it } from "vitest";
import { parseReferencePriceInput, referenceLineCost, referencePriceUnit } from "./ingredientPrice";

describe("ingredient reference prices", () => {
  it("labels price per kilogram, liter or whole unit", () => {
    expect(referencePriceUnit("mass")).toBe("kg");
    expect(referencePriceUnit("volume")).toBe("L");
    expect(referencePriceUnit("count")).toBe("un");
  });
  it("distinguishes no reference from an explicitly free ingredient", () => {
    expect(parseReferencePriceInput("  ")).toBeNull();
    expect(parseReferencePriceInput("0")).toBe(0);
    expect(parseReferencePriceInput("25000.75")).toBe(2500075);
    expect(parseReferencePriceInput("20000000.00")).toBe(2000000000);
  });
  it.each(["-1", "1.001", "Infinity", "1e5", "25,000", "abc", "20000000.01"])("rejects invalid price %s", value => {
    expect(parseReferencePriceInput(value)).toBe("invalid");
  });
  it("suggests line cost from exact quantities, including fractions of one count unit", () => {
    expect(referenceLineCost(2500000, 2500)).toBe(6250000);
    expect(referenceLineCost(1000, 125)).toBe(125);
    expect(referenceLineCost(1, 500)).toBe(1);
    expect(referenceLineCost(1, 499)).toBe(0);
    expect(referenceLineCost(0, 500)).toBe(0);
    expect(referenceLineCost(2000000000, 1000)).toBe(2000000000);
  });
  it.each([
    [null, 1000], [undefined, 1000], [-1, 1000], [1.5, 1000], [NaN, 1000],
    [2000000001, 1000], [1000, 0], [1000, -1], [1000, 0.5], [1000, Infinity],
    [1000, 2000000001], [2000000000, 2000000000],
  ])("does not suggest unrepresentable or missing totals (%s, %s)", (price, qty) => {
    expect(referenceLineCost(price, qty as number)).toBeNull();
  });
});
