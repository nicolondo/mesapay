// Datos FICTICIOS para los tests del documento soporte (ningún comercio,
// proveedor ni NIT real).
import type { SupportDocBuyer, SupportDocLine, SupportDocSeller } from "../types";

export const BUYER: SupportDocBuyer = {
  personType: "1",
  name: "Restaurante de Prueba SAS",
  nit: "900373076",
  dv: "4",
  taxLevelCode: "R-99-PN",
  taxSchemeId: "ZZ",
};

export const RESIDENT_SELLER: SupportDocSeller = {
  personType: "2",
  name: "Pedro Pérez & Hijos",
  companyId: "1020304050",
  dv: "1",
  idSchemeName: "31",
  taxLevelCode: "R-99-PN",
  address: {
    kind: "resident",
    cityCode: "05266",
    cityName: "Envigado",
    postalZone: "055422",
    deptCode: "05",
    deptName: "Antioquia",
    line: "Calle 10 # 20-30",
  },
};

export const FOREIGN_SELLER: SupportDocSeller = {
  personType: "1",
  name: "Proveedor Extranjero LLC",
  companyId: "A1234567",
  dv: null,
  idSchemeName: "50",
  taxLevelCode: "R-99-PN",
  address: {
    kind: "foreign",
    cityName: "Miami",
    countryCode: "US",
    countryName: "Estados Unidos",
    line: null,
  },
};

export function line(overrides: Partial<SupportDocLine> = {}): SupportDocLine {
  return {
    description: "Arreglo de la nevera",
    quantity: 1,
    unitCode: "94",
    unitPriceCents: 10_000_000,
    lineTotalCents: 10_000_000,
    ivaCents: 0,
    ivaPct: "0.00",
    itemCode: "G-1",
    purchaseDate: "2026-11-13",
    generationForm: "1",
    withholdings: [],
    ...overrides,
  };
}

export const RESOLUTION = {
  number: "18760000001",
  prefix: "DS",
  from: 1000,
  to: 2000,
  startDate: "2026-01-01",
  endDate: "2027-12-31",
};
