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

// Datos reales de Son & Melona (Envigado, Antioquia) — el comercio que
// destapó los dos bugs: el número de resolución duplicado y el emisor
// mandando Bogotá.
function emisor(over: Partial<EmisorData> = {}): EmisorData {
  return {
    ref: { kind: "restaurant", id: "r1" },
    legalName: "SON Y MELONA S.A.S.",
    taxId: "901944469-1",
    addressLine: "CR 6 24 A SUR 285 LC 112",
    cityName: "ENVIGADO",
    legalCityCode: "05266",
    resolution: null,
    resolutionFrom: 990000000,
    resolutionTo: 995000000,
    resolutionNumber: "18760000001",
    resolutionValidFrom: "2019-01-19",
    resolutionValidTo: "2030-01-19",
    resolutionDate: "2025-06-26",
    invoicePrefix: "SETP",
    invoiceNextNumber: 990000000,
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
  it("no falta nada con el municipio cargado", () => {
    expect(missingLocationFields(emisor())).toEqual([]);
  });

  it("bloquea cuando no hay código — antes se mandaba Bogotá por defecto", () => {
    expect(missingLocationFields(emisor({ legalCityCode: null }))).toEqual([
      "legalCityCode",
    ]);
  });

  it("bloquea con un código que no existe en DIVIPOLA", () => {
    expect(missingLocationFields(emisor({ legalCityCode: "04001" }))).toEqual([
      "legalCityCode",
    ]);
  });

  it("no se conforma con el texto libre de la ciudad", () => {
    expect(
      missingLocationFields(
        emisor({ legalCityCode: null, cityName: "ENVIGADO" }),
      ),
    ).toEqual(["legalCityCode"]);
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

  it("el nombre sale del catálogo, no del texto libre que escribió el comercio", () => {
    // legalCity decía "ENVIGADO" en mayúsculas; al XML va el nombre
    // oficial DANE, así nombre y código no pueden contradecirse.
    const party = emisorToSupplierParty(emisor({ cityName: "MEDELLIN" }));
    expect(party.address?.cityName).toBe("Envigado");
  });

  it("resuelve Bogotá bien cuando el comercio SÍ es de Bogotá", () => {
    const party = emisorToSupplierParty(emisor({ legalCityCode: "11001" }));
    expect(party.address?.cityCode).toBe("11001");
    expect(party.address?.deptCode).toBe("11");
    // Antes el deptName repetía el nombre de la ciudad; ahora sale del
    // catálogo aun en el caso donde municipio y departamento coinciden.
    expect(party.address?.deptName).toBe("Bogotá, D.C.");
  });

  it("no arma dirección sin municipio en vez de inventar una", () => {
    expect(
      emisorToSupplierParty(emisor({ legalCityCode: null })).address,
    ).toBeNull();
  });

  it("sigue calculando el DV del NIT", () => {
    const party = emisorToSupplierParty(emisor());
    expect(party.companyId).toBe("901944469");
    expect(party.dv).toBe("1");
  });
});
