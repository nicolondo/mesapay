import { describe, expect, it } from "vitest";
import { normalizeNumberText } from "./numberText";

describe("normalizeNumberText — convención nueva, sin adivinar", () => {
  it.each([
    ["1,250", "1250"],
    ["1,234,567", "1234567"],
    ["1,234,567.89", "1234567.89"],
    ["1.25", "1.25"],
    ["1.250", "1.250"],
    ["$ 25,000", "25000"],
    ["COP 25 000", "25000"],
    ["25000", "25000"],
    [".5", "0.5"],
    ["007", "7"],
  ])("«%s» → %s", (raw, expected) => {
    expect(normalizeNumberText(raw)).toBe(expected);
  });

  it.each([
    ["1.234.567,89", "1234567.89"],
    ["$ 25.000,50", "25000.50"],
    ["1.234.567", "1234567"],
    ["12,5", "12.5"],
    ["0,05", "0.05"],
    ["12,", "12."],
    ["0,002", "0.002"],
    ["0.002", "0.002"],
  ])("formato viejo sin ambigüedad «%s» → %s", (raw, expected) => {
    expect(normalizeNumberText(raw)).toBe(expected);
  });

  it.each(["", "abc", "1e6", "12,34,567", "1.2.3", "1,234.567.8", "1.234,", "--5", "1,2,3"])(
    "rechaza «%s»",
    (raw) => {
      expect(normalizeNumberText(raw)).toBeNull();
    },
  );

  it("negativos solo cuando se piden", () => {
    expect(normalizeNumberText("-1,250.5")).toBeNull();
    expect(normalizeNumberText("-1,250.5", { allowNegative: true })).toBe("-1250.5");
  });

  it("con tope de decimales: rechaza lo ambiguo en vez de adivinar", () => {
    // «25.000» puede ser 25 (nuevo) o 25000 (viejo): no se adivina.
    expect(normalizeNumberText("25.000", { maxFractionDigits: 0 })).toBeNull();
    expect(normalizeNumberText("25.000", { maxFractionDigits: 2 })).toBeNull();
    expect(normalizeNumberText("1.250", { maxFractionDigits: 2 })).toBeNull();
    // Ceros que sobran no cambian el valor.
    expect(normalizeNumberText("1,234.00", { maxFractionDigits: 0 })).toBe("1234");
    expect(normalizeNumberText("1,234.5", { maxFractionDigits: 0 })).toBeNull();
    expect(normalizeNumberText("1,234.56", { maxFractionDigits: 2 })).toBe("1234.56");
    expect(normalizeNumberText("1.234.567,89", { maxFractionDigits: 2 })).toBe("1234567.89");
  });
});
