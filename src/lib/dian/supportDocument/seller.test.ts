import { describe, expect, it } from "vitest";
import { isValidPostalCode } from "./catalogs";
import {
  customizationFor,
  foreignIdScheme,
  missingSellerFields,
  sellerFromSupplier,
  sellerPersonType,
  type SupplierForSupportDoc,
} from "./seller";

const RESIDENT: SupplierForSupportDoc = {
  id: "s1",
  name: "  Pedro Pérez  ",
  taxId: "1.020.304.050",
  taxIdType: "CC",
  personType: null,
  address: "Calle 10 # 20-30",
  notObligatedToInvoice: true,
  cityCode: "05266",
  postalCode: "055422",
  countryCode: null,
  foreignCityName: null,
};

describe("vendedor residente (CustomizationID 10)", () => {
  it("completo: NIT = cédula con DV calculado y dirección DANE + postal", () => {
    expect(missingSellerFields(RESIDENT)).toEqual([]);
    const s = sellerFromSupplier(RESIDENT);
    expect(s).toMatchObject({
      personType: "2",
      name: "Pedro Pérez",
      companyId: "1020304050",
      idSchemeName: "31",
      taxLevelCode: "R-99-PN",
    });
    expect(s.dv).toMatch(/^\d$/);
    expect(s.address).toMatchObject({ kind: "resident", cityCode: "05266", deptCode: "05", postalZone: "055422" });
    expect(customizationFor(RESIDENT)).toBe("10");
  });

  it("un NIT escrito con DV se limpia y el DV se recalcula", () => {
    const s = sellerFromSupplier({ ...RESIDENT, taxId: "900373076-9", taxIdType: "NIT", personType: "juridica" });
    expect(s.companyId).toBe("900373076");
    expect(s.dv).toBe("4");
    expect(s.personType).toBe("1");
  });

  it("pide lo que falta, sin inventar", () => {
    expect(
      missingSellerFields({
        ...RESIDENT,
        notObligatedToInvoice: false,
        taxId: null,
        taxIdType: "NIT",
        cityCode: null,
        postalCode: "000000",
        address: " ",
      }),
    ).toEqual(["not_flagged", "person_type", "document", "city", "postal_code", "address"]);
  });

  it("DSAJ25a: un residente con pasaporte no se puede identificar con NIT", () => {
    expect(missingSellerFields({ ...RESIDENT, taxIdType: "PA", taxId: "AB123" })).toContain("resident_requires_nit");
  });

  it("el código postal tiene que existir y ser del departamento del municipio", () => {
    expect(isValidPostalCode("055422", "05")).toBe(true);
    expect(isValidPostalCode("110111", "05")).toBe(false);
    expect(isValidPostalCode("999999")).toBe(false);
    expect(missingSellerFields({ ...RESIDENT, postalCode: "110111" })).toEqual(["postal_code"]);
  });

  it("no arma un vendedor incompleto", () => {
    expect(() => sellerFromSupplier({ ...RESIDENT, cityCode: null })).toThrow("seller_incomplete");
  });
});

describe("vendedor no residente (CustomizationID 11)", () => {
  const FOREIGN: SupplierForSupportDoc = {
    ...RESIDENT,
    taxId: "A-123 4567",
    taxIdType: "PA",
    countryCode: "us",
    foreignCityName: "Miami",
    cityCode: null,
    postalCode: null,
    address: null,
  };

  it("usa el país de la tabla 16.4.1 y el tipo de documento de la 16.2.1", () => {
    expect(missingSellerFields(FOREIGN)).toEqual([]);
    expect(customizationFor(FOREIGN)).toBe("11");
    const s = sellerFromSupplier(FOREIGN);
    expect(s).toMatchObject({ companyId: "A1234567", dv: null, idSchemeName: "41" });
    expect(s.address).toEqual({ kind: "foreign", cityName: "Miami", countryCode: "US", countryName: "Estados Unidos", line: null });
  });

  it("país y ciudad obligatorios", () => {
    expect(missingSellerFields({ ...FOREIGN, countryCode: "XX", foreignCityName: "" })).toEqual(["country", "foreign_city"]);
  });

  it("mapea los tipos de documento", () => {
    expect(foreignIdScheme("NIT")).toBe("50");
    expect(foreignIdScheme("CE")).toBe("22");
    expect(foreignIdScheme(null)).toBe("42");
  });
});

describe("tipo de persona", () => {
  it("sólo se deduce cuando el documento lo deja claro", () => {
    expect(sellerPersonType({ personType: null, taxIdType: "CC" })).toBe("2");
    expect(sellerPersonType({ personType: null, taxIdType: "NIT" })).toBeNull();
    expect(sellerPersonType({ personType: "juridica", taxIdType: "CC" })).toBe("1");
  });
});
