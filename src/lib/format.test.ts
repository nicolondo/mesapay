import { describe, expect, it } from "vitest";
import { formatMoney, formatNumber } from "./format";

describe("amounts whose currency is not recorded", () => {
  it("shows localized numbers without inventing a currency", () => {
    expect(formatNumber(15000.25, { locale: "es" })).toBe("15.000,25");
    expect(formatNumber(15000.25, { locale: "en" })).toBe("15,000.25");
    expect(formatNumber(-15000.25, { locale: "pt" })).toBe("-15.000,25");
  });
});

describe("exact fiscal amounts", () => {
  it("keeps the existing COP default", () => {
    expect(formatMoney(123456, { currency: "COP", locale: "es" }).replace(/\s/g, "")).toBe("$1.235");
  });
  it("shows every cent when requested for a fiscal review", () => {
    expect(formatMoney(123456, { currency: "COP", locale: "es", fractionDigits: 2 }).replace(/\s/g, "")).toBe("$1.234,56");
    expect(formatMoney(1, { currency: "COP", locale: "en", fractionDigits: 2 }).replace(/\s/g, "")).toBe("$0.01");
    expect(formatMoney(0, { currency: "COP", locale: "pt", fractionDigits: 2 })).toContain("0,00");
  });
});
