import { describe, expect, it } from "vitest";
import { parseDecimalInput, sanitizeDecimalInput } from "./decimalInput";

describe("sanitizeDecimalInput", () => {
  it("deja pasar coma y punto por igual", () => {
    expect(sanitizeDecimalInput("0,05")).toBe("0,05");
    expect(sanitizeDecimalInput("0.05")).toBe("0.05");
  });

  it("descarta lo que no es número ni separador", () => {
    expect(sanitizeDecimalInput("12a,5kg")).toBe("12,5");
    expect(sanitizeDecimalInput("abc")).toBe("");
  });

  it("conserva un solo separador", () => {
    expect(sanitizeDecimalInput("1,2,3")).toBe("1,23");
    expect(sanitizeDecimalInput("1.2.3")).toBe("1.23");
  });

  it("sólo admite signo negativo cuando se pide", () => {
    expect(sanitizeDecimalInput("-0,5")).toBe("0,5");
    expect(sanitizeDecimalInput("-0,5", { allowNegative: true })).toBe("-0,5");
  });
});

describe("parseDecimalInput", () => {
  it("interpreta la coma como decimal", () => {
    expect(parseDecimalInput("0,05")).toBe(0.05);
    expect(parseDecimalInput("0.05")).toBe(0.05);
    expect(parseDecimalInput("10")).toBe(10);
  });

  it("devuelve NaN en vacío — no 0, que era el bug", () => {
    expect(parseDecimalInput("")).toBeNaN();
    expect(parseDecimalInput("   ")).toBeNaN();
  });

  it("tolera un separador colgando al final", () => {
    expect(parseDecimalInput("12,")).toBe(12);
  });
});
