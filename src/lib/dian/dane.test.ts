import { describe, expect, it } from "vitest";
import {
  DANE_CITIES,
  DANE_DEPARTMENTS,
  isValidDaneCode,
  resolveDaneLocation,
} from "./dane";

describe("DANE_DEPARTMENTS", () => {
  it("tiene los 32 departamentos + Bogotá D.C.", () => {
    expect(Object.keys(DANE_DEPARTMENTS)).toHaveLength(33);
  });

  it("usa códigos de exactamente dos dígitos", () => {
    for (const code of Object.keys(DANE_DEPARTMENTS)) {
      expect(code).toMatch(/^\d{2}$/);
    }
  });
});

describe("DANE_CITIES", () => {
  it("no repite códigos", () => {
    const codes = DANE_CITIES.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("todo municipio pertenece a un departamento real", () => {
    for (const city of DANE_CITIES) {
      expect(city.code).toMatch(/^\d{5}$/);
      expect(DANE_DEPARTMENTS[city.code.slice(0, 2)]).toBeDefined();
    }
  });
});

describe("isValidDaneCode", () => {
  it("acepta un municipio real", () => {
    expect(isValidDaneCode("05266")).toBe(true); // Envigado
  });

  it("rechaza vacío, longitud errónea y no-dígitos", () => {
    expect(isValidDaneCode(null)).toBe(false);
    expect(isValidDaneCode("")).toBe(false);
    expect(isValidDaneCode("5266")).toBe(false);
    expect(isValidDaneCode("052660")).toBe(false);
    expect(isValidDaneCode("0526A")).toBe(false);
  });

  it("rechaza un departamento que no existe", () => {
    // 04 no es un departamento DIVIPOLA.
    expect(isValidDaneCode("04001")).toBe(false);
  });
});

describe("resolveDaneLocation", () => {
  it("resuelve Envigado, Antioquia — el caso que mandaba Bogotá", () => {
    expect(resolveDaneLocation("05266", "ENVIGADO")).toEqual({
      cityCode: "05266",
      cityName: "Envigado",
      deptCode: "05",
      deptName: "Antioquia",
    });
  });

  it("deriva el departamento del propio código, no de la ciudad", () => {
    const loc = resolveDaneLocation("11001", "Bogotá");
    expect(loc?.deptCode).toBe("11");
    expect(loc?.deptName).toBe("Bogotá, D.C.");
  });

  it("usa el texto libre del comercio para municipios fuera de la lista", () => {
    // 05045 (Apartadó) no está en la lista acotada.
    expect(resolveDaneLocation("05045", "Apartadó")).toEqual({
      cityCode: "05045",
      cityName: "Apartadó",
      deptCode: "05",
      deptName: "Antioquia",
    });
  });

  it("devuelve null sin código: no inventa una ubicación", () => {
    expect(resolveDaneLocation(null, "ENVIGADO")).toBeNull();
    expect(resolveDaneLocation("", "ENVIGADO")).toBeNull();
  });

  it("devuelve null si el municipio es desconocido y no hay ciudad", () => {
    expect(resolveDaneLocation("05045", null)).toBeNull();
    expect(resolveDaneLocation("05045", "   ")).toBeNull();
  });
});
