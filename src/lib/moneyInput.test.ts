import { describe, expect, it } from "vitest";
import {
  formatMoneyInput,
  parseMoneyInput,
  parseMoneyPaste,
  typedDecimalComma,
} from "./moneyInput";

describe("money entry preserves monetary values", () => {
  it.each(["es", "en", "pt"] as const)(
    "groups with «,» and uses «.» as decimal in %s",
    (locale) => {
      expect(formatMoneyInput("25000", locale)).toBe("25,000");
      expect(formatMoneyInput("25000.50", locale, 2)).toBe("25,000.50");
      expect(parseMoneyInput("25,000.50", locale, 2)).toBe("25000.50");
      expect(formatMoneyInput("25000.50", locale)).toBe("25,000"); // never 2,500,050
      expect(formatMoneyInput("1234567.89", locale, 2)).toBe("1,234,567.89");
    },
  );
  it("keeps empty, zero, negative and partially entered decimals distinct", () => {
    expect(formatMoneyInput("", "es", 2)).toBe("");
    expect(formatMoneyInput("0", "es", 2)).toBe("0");
    expect(formatMoneyInput("-1250.5", "es", 2)).toBe("-1,250.5");
    expect(parseMoneyInput("-1,250.5", "es", 2, true)).toBe("-1250.5");
    expect(parseMoneyInput("-", "es", 2, true)).toBe("-");
    expect(parseMoneyInput("25,000.", "es", 2)).toBe("25000.");
    expect(parseMoneyInput(".5", "es", 2)).toBe("0.5");
    expect(parseMoneyInput("00025", "es")).toBe("25");
  });
  it("«1,250» es mil doscientos cincuenta y «1.25» uno con veinticinco", () => {
    expect(parseMoneyInput("1,250", "es")).toBe("1250");
    expect(parseMoneyInput("1.25", "es", 2)).toBe("1.25");
    expect(parseMoneyPaste("1,250", "es")).toBe("1250");
    expect(parseMoneyPaste("1.25", "es", 2)).toBe("1.25");
  });
  it.each(["$ 25,000", "25,000", "COP 25 000", "25000", "25.000,00", "25,000.00"])(
    "pastes integers: %s",
    (value) => {
      expect(parseMoneyPaste(value, "es")).toBe("25000");
    },
  );
  it.each(["$ 25.000,50", "25,000.50", "25000.50", "25000,50"])(
    "pastes decimals (new convention or unambiguous old format) without magnifying the amount: %s",
    (value) => {
      expect(parseMoneyPaste(value, "es", 2)).toBe("25000.50");
      expect(parseMoneyPaste(value, "es", 0)).toBeNull();
    },
  );
  it("does not guess ambiguous pastes", () => {
    // «25.000»: ¿25 (convención nueva) o 25000 (formato viejo)? Se rechaza.
    expect(parseMoneyPaste("25.000", "es")).toBeNull();
    expect(parseMoneyPaste("$ 25.000", "es", 2)).toBeNull();
    // Varios puntos solo pueden ser miles del formato viejo.
    expect(parseMoneyPaste("1.234.567", "es")).toBe("1234567");
  });
  it("rejects exponent notation, invalid signs, excessive precision and oversized values", () => {
    expect(parseMoneyInput("1e6", "es")).toBeNull();
    expect(parseMoneyInput("-1000", "es")).toBeNull();
    expect(parseMoneyInput("1.234", "es", 2)).toBeNull();
    expect(parseMoneyInput("1234567890123", "es")).toBeNull();
    expect(parseMoneyPaste("1,234.567", "es", 2)).toBeNull();
    expect(parseMoneyPaste("-25,000", "es")).toBeNull();
    expect(parseMoneyPaste("-25,000", "es", 0, true)).toBe("-25000");
    expect(parseMoneyPaste("1e6", "es")).toBeNull();
  });
});

describe("typed decimal comma (keypads in Spanish)", () => {
  it("turns a single typed comma into the decimal point in decimal fields", () => {
    expect(typedDecimalComma("1,234", "1,234,", 6, 2)).toBe("1,234.");
    expect(typedDecimalComma("12", "12,", 3, 2)).toBe("12.");
  });
  it("leaves integer fields, grouping and edits alone", () => {
    expect(typedDecimalComma("1,234", "1,234,", 6, 0)).toBe("1,234,");
    expect(typedDecimalComma("123", "1234", 4, 2)).toBe("1234");
    expect(typedDecimalComma("1,23", "1,234", 5, 2)).toBe("1,234");
  });
  it("ignores a second decimal", () => {
    expect(typedDecimalComma("12.5", "12.5,", 5, 2)).toBe("12.5");
  });
});
