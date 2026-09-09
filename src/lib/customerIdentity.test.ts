import { describe, it, expect } from "vitest";
import {
  normalizeCedula,
  isValidCedula,
  resolveLoginIdentifier,
} from "./customerIdentity";

describe("normalizeCedula", () => {
  it("quita puntos, espacios y guiones", () => {
    // El porqué: la misma persona teclea su documento de tres formas
    // distintas. Sin normalizar, el UNIQUE dejaría crear tres cuentas.
    expect(normalizeCedula("1.020.304")).toBe("1020304");
    expect(normalizeCedula("1 020 304")).toBe("1020304");
    expect(normalizeCedula("1-020-304")).toBe("1020304");
    expect(normalizeCedula("  1020304  ")).toBe("1020304");
  });

  it("acepta documentos alfanuméricos y los sube a mayúsculas", () => {
    // Pasaporte / cédula de extranjería: el comensal extranjero también come.
    expect(normalizeCedula("ab-123456")).toBe("AB123456");
  });

  it("tolera null/undefined/vacío", () => {
    expect(normalizeCedula(null)).toBe("");
    expect(normalizeCedula(undefined)).toBe("");
    expect(normalizeCedula("")).toBe("");
  });
});

describe("isValidCedula", () => {
  it("rechaza documentos demasiado cortos o demasiado largos", () => {
    expect(isValidCedula("123")).toBe(false);
    expect(isValidCedula("1".repeat(21))).toBe(false);
  });

  it("acepta los largos plausibles", () => {
    expect(isValidCedula("12345")).toBe(true);
    expect(isValidCedula("1.020.304")).toBe(true);
  });
});

describe("resolveLoginIdentifier", () => {
  it("trata lo que tiene @ como correo, en minúsculas", () => {
    expect(resolveLoginIdentifier("  Ana@Example.COM ")).toEqual({
      kind: "email",
      value: "ana@example.com",
    });
  });

  it("trata lo demás como cédula, normalizada", () => {
    expect(resolveLoginIdentifier("1.020.304")).toEqual({
      kind: "cedula",
      value: "1020304",
    });
  });

  it("marca inválido lo vacío o lo que no llega a documento", () => {
    expect(resolveLoginIdentifier("")).toEqual({ kind: "invalid" });
    expect(resolveLoginIdentifier("   ")).toEqual({ kind: "invalid" });
    expect(resolveLoginIdentifier("42")).toEqual({ kind: "invalid" });
    expect(resolveLoginIdentifier("no-es-correo@")).toEqual({ kind: "invalid" });
  });
});
