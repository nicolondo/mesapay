import { describe, expect, it } from "vitest";
import { defaultSalesTaxForCountry } from "./salesTax";

describe("defaultSalesTaxForCountry", () => {
  it("Colombia nace con impoconsumo del 8%", () => {
    expect(defaultSalesTaxForCountry("CO")).toEqual({ kind: "inc", pct: 8 });
  });

  it("no importa cómo venga escrito el país", () => {
    expect(defaultSalesTaxForCountry("co")).toEqual({ kind: "inc", pct: 8 });
    expect(defaultSalesTaxForCountry(" Co ")).toEqual({ kind: "inc", pct: 8 });
  });

  it("un país sin regla NO inventa un impuesto", () => {
    expect(defaultSalesTaxForCountry("MX")).toEqual({ kind: "none", pct: 0 });
    expect(defaultSalesTaxForCountry("BR")).toEqual({ kind: "none", pct: 0 });
  });

  it("sin país tampoco", () => {
    expect(defaultSalesTaxForCountry(null)).toEqual({ kind: "none", pct: 0 });
    expect(defaultSalesTaxForCountry(undefined)).toEqual({ kind: "none", pct: 0 });
    expect(defaultSalesTaxForCountry("  ")).toEqual({ kind: "none", pct: 0 });
  });
});
