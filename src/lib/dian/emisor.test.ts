import { describe, expect, it, vi } from "vitest";

// config.ts importa el cliente Prisma en el tope. Las funciones que se
// prueban acá son puras (no tocan la DB), así que se stubea el módulo para
// que el import no intente abrir una conexión.
vi.mock("@/lib/db", () => ({ db: {} }));

import {
  emisorToSupplierParty,
  legacyResolutionConflict,
  missingLocationFields,
  type EmisorData,
} from "./config";

function emisor(over: Partial<EmisorData> = {}): EmisorData {
  return {
    ref: { kind: "restaurant", id: "r1" },
    legalName: "SON Y MELONA S.A.S.",
    taxId: "901944469-1",
    addressLine: "CR 6 24 A SUR 285 LC 112",
    cityName: "ENVIGADO",
    resolution: null,
    resolutionFrom: 990000000,
    resolutionTo: 995000000,
    resolutionNumber: "18760000001",
    resolutionValidFrom: "2019-01-19",
    resolutionValidTo: "2030-01-19",
    resolutionDate: "2025-06-26",
    daneCityCode: "05266",
    invoicePrefix: "SETP",
    invoiceNextNumber: 1,
    ...over,
  };
}

describe("legacyResolutionConflict", () => {
  it("detecta el caso real: texto de Identidad ≠ número que va a la DIAN", () => {
    expect(
      legacyResolutionConflict({
        resolution: "18764094877213",
        resolutionNumber: "18760000001",
      }),
    ).toBe("18764094877213");
  });

  it("no marca conflicto si el texto contiene al número", () => {
    expect(
      legacyResolutionConflict({
        resolution: "Resolución 18760000001 del 1 de enero de 2024",
        resolutionNumber: "18760000001",
      }),
    ).toBeNull();
  });

  it("no marca conflicto sin texto o sin número", () => {
    expect(
      legacyResolutionConflict({ resolution: null, resolutionNumber: "123" }),
    ).toBeNull();
    // Sin número el texto es un candidato, no un conflicto.
    expect(
      legacyResolutionConflict({ resolution: "123", resolutionNumber: null }),
    ).toBeNull();
  });
});

describe("missingLocationFields", () => {
  it("no falta nada con el código cargado", () => {
    expect(missingLocationFields(emisor())).toEqual([]);
  });

  it("bloquea cuando no hay código — antes se mandaba Bogotá por defecto", () => {
    expect(missingLocationFields(emisor({ daneCityCode: null }))).toEqual([
      "daneCityCode",
    ]);
  });

  it("bloquea con un código inventado", () => {
    expect(missingLocationFields(emisor({ daneCityCode: "04001" }))).toEqual([
      "daneCityCode",
    ]);
  });

  it("pide la ciudad si el municipio no está en la lista acotada", () => {
    expect(
      missingLocationFields(
        emisor({ daneCityCode: "05045", cityName: null }),
      ),
    ).toEqual(["cityName"]);
  });
});

describe("emisorToSupplierParty", () => {
  it("manda el municipio REAL del comercio, no Bogotá", () => {
    const party = emisorToSupplierParty(emisor());
    expect(party.address).toEqual({
      cityCode: "05266",
      cityName: "Envigado",
      deptCode: "05",
      deptName: "Antioquia",
      line: "CR 6 24 A SUR 285 LC 112",
    });
  });

  it("no arma dirección sin código DANE en vez de inventar una", () => {
    expect(emisorToSupplierParty(emisor({ daneCityCode: null })).address).toBeNull();
  });

  it("sigue calculando el DV del NIT", () => {
    const party = emisorToSupplierParty(emisor());
    expect(party.companyId).toBe("901944469");
    expect(party.dv).toBe("1");
  });
});
