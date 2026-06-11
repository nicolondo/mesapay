import { describe, it, expect } from "vitest";
import { normalizeLeadName } from "./dupes";

describe("normalizeLeadName", () => {
  it("canonical example from spec", () => {
    expect(normalizeLeadName("Restaurante El Asadero S.A.S.")).toBe("asadero");
  });

  it("lowercases", () => {
    expect(normalizeLeadName("PIZZA NOVA")).toBe("pizza nova");
  });

  it("strips accents", () => {
    expect(normalizeLeadName("Café Bogotá")).toBe("cafe bogota");
  });

  it("removes punctuation", () => {
    expect(normalizeLeadName("Tacos & Más, S.A.")).toBe("tacos mas");
  });

  it("removes generic word 'restaurant'", () => {
    expect(normalizeLeadName("restaurant La Paloma")).toBe("paloma");
  });

  it("removes 'sas' suffix", () => {
    expect(normalizeLeadName("El Fogón SAS")).toBe("fogon");
  });

  it("removes 'ltda' suffix", () => {
    expect(normalizeLeadName("Parrilla El Rey Ltda")).toBe("parrilla rey");
  });

  it("collapses multiple spaces", () => {
    expect(normalizeLeadName("  El   Bueno  ")).toBe("bueno");
  });

  it("handles empty string", () => {
    expect(normalizeLeadName("")).toBe("");
  });

  it("all generic → empty string", () => {
    expect(normalizeLeadName("Restaurante SAS S.A.S.")).toBe("");
  });

  it("preserves non-generic words with numbers", () => {
    expect(normalizeLeadName("Bar 42 S.A.")).toBe("bar 42");
  });
});
