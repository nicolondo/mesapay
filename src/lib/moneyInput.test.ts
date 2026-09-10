import { describe, expect, it } from "vitest";
import {
  formatMoneyInput,
  parseMoneyInput,
  parseMoneyPaste,
} from "./moneyInput";

describe("money entry preserves monetary values", () => {
  it.each([
    ["es", "25.000", "25.000,50"],
    ["en", "25,000", "25,000.50"],
    ["pt", "25.000", "25.000,50"],
  ] as const)(
    "groups while preserving decimals in %s",
    (locale, integer, fractional) => {
      expect(formatMoneyInput("25000", locale)).toBe(integer);
      expect(formatMoneyInput("25000.50", locale, 2)).toBe(fractional);
      expect(parseMoneyInput(fractional, locale, 2)).toBe("25000.50");
      expect(formatMoneyInput("25000.50", locale)).toBe(integer); // never 2,500,050
    },
  );
  it("keeps empty, zero, negative and partially entered decimals distinct", () => {
    expect(formatMoneyInput("", "es", 2)).toBe("");
    expect(formatMoneyInput("0", "es", 2)).toBe("0");
    expect(formatMoneyInput("-1250.5", "es", 2)).toBe("-1.250,5");
    expect(parseMoneyInput("-1.250,5", "es", 2, true)).toBe("-1250.5");
    expect(parseMoneyInput("-", "es", 2, true)).toBe("-");
    expect(parseMoneyInput("25.000,", "es", 2)).toBe("25000.");
    expect(parseMoneyInput(",5", "es", 2)).toBe("0.5");
    expect(parseMoneyInput("00025", "es")).toBe("25");
  });
  it.each(["$ 25.000", "25,000", "COP 25 000", "25000"])(
    "pastes grouped integers: %s",
    (value) => {
      expect(parseMoneyPaste(value, "es")).toBe("25000");
    },
  );
  it.each(["$ 25.000,50", "25,000.50", "25000.50", "25000,50"])(
    "pastes decimals without magnifying the amount: %s",
    (value) => {
      expect(parseMoneyPaste(value, "es", 2)).toBe("25000.50");
      expect(parseMoneyPaste(value, "es", 0)).toBeNull();
    },
  );
  it("rejects exponent notation, invalid signs, excessive precision and oversized values", () => {
    expect(parseMoneyInput("1e6", "es")).toBeNull();
    expect(parseMoneyInput("-1000", "es")).toBeNull();
    expect(parseMoneyInput("1,234", "es", 2)).toBeNull();
    expect(parseMoneyInput("1234567890123", "es")).toBeNull();
    expect(parseMoneyPaste("1,234.567", "es", 2)).toBeNull();
    expect(parseMoneyPaste("-25.000", "es")).toBeNull();
    expect(parseMoneyPaste("1e6", "es")).toBeNull();
  });
});
