import { describe, expect, it } from "vitest";
import { formatMoney } from "./format";

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
