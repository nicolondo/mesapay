import { describe, expect, it } from "vitest";
import { parseDecimalInput, sanitizeDecimalInput } from "./decimalInput";

describe("sanitizeDecimalInput", () => {
  it("el separador tecleado (punto o coma del teclado) es el decimal y se ve como punto", () => {
    expect(sanitizeDecimalInput("0,05")).toBe("0.05");
    expect(sanitizeDecimalInput("0.05")).toBe("0.05");
    expect(sanitizeDecimalInput("12,")).toBe("12.");
    expect(sanitizeDecimalInput(",")).toBe(".");
  });

  it("descarta lo que no es número ni separador", () => {
    expect(sanitizeDecimalInput("12a,5kg")).toBe("12.5");
    expect(sanitizeDecimalInput("abc")).toBe("");
  });

  it("conserva un solo separador", () => {
    expect(sanitizeDecimalInput("1,2,3")).toBe("1.23");
    expect(sanitizeDecimalInput("1.2.3")).toBe("1.23");
    expect(sanitizeDecimalInput("1.5,")).toBe("1.5");
  });

  it("lo pegado con miles sigue la convención y el formato viejo sin ambigüedad", () => {
    expect(sanitizeDecimalInput("1,250")).toBe("1250");
    expect(sanitizeDecimalInput("1,234.5")).toBe("1234.5");
    expect(sanitizeDecimalInput("1.234,5")).toBe("1234.5");
    expect(sanitizeDecimalInput("1.234.567")).toBe("1234567");
  });

  it("sólo admite signo negativo cuando se pide", () => {
    expect(sanitizeDecimalInput("-0,5")).toBe("0.5");
    expect(sanitizeDecimalInput("-0,5", { allowNegative: true })).toBe("-0.5");
  });
});

describe("parseDecimalInput", () => {
  it("punto decimal; tolera la coma decimal", () => {
    expect(parseDecimalInput("0,05")).toBe(0.05);
    expect(parseDecimalInput("0.05")).toBe(0.05);
    expect(parseDecimalInput("10")).toBe(10);
    expect(parseDecimalInput("-2.5")).toBe(-2.5);
  });

  it("miles con coma", () => {
    expect(parseDecimalInput("1,250")).toBe(1250);
    expect(parseDecimalInput("1,250.75")).toBe(1250.75);
  });

  it("devuelve NaN en vacío — no 0, que era el bug", () => {
    expect(parseDecimalInput("")).toBeNaN();
    expect(parseDecimalInput("   ")).toBeNaN();
    expect(parseDecimalInput("abc")).toBeNaN();
  });

  it("tolera un separador colgando al final", () => {
    expect(parseDecimalInput("12,")).toBe(12);
    expect(parseDecimalInput("12.")).toBe(12);
  });
});
