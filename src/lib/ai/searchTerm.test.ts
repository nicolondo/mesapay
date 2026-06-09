import { describe, it, expect } from "vitest";
import { normalizeTerm } from "./searchTerm";

describe("normalizeTerm", () => {
  it("lower + sin acentos + trim + colapsa espacios", () => {
    expect(normalizeTerm("  Café   con Leche ")).toBe("cafe con leche");
    expect(normalizeTerm("ÑOQUIS")).toBe("noquis");
  });
  it("vacío o <2 chars → null", () => {
    expect(normalizeTerm(" ")).toBeNull();
    expect(normalizeTerm("a")).toBeNull();
  });
});
