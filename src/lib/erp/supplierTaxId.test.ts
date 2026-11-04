import { describe, expect, it } from "vitest";
import {
  defaultPersonType,
  findSupplierByTaxId,
  normalizeSupplierTaxId,
  sameSupplierTaxId,
  supplierTaxKey,
} from "./supplierTaxId";
import { supplierTercero } from "./exogena/sources";

describe("documento del proveedor", () => {
  it("el NIT se guarda con el DV calculado (mismo módulo 11 de la factura electrónica)", () => {
    expect(normalizeSupplierTaxId("NIT", "901.944.469")).toEqual({
      ok: true,
      taxId: "901944469-1",
      docNumber: "901944469",
      verificationDigit: "1",
    });
    expect(normalizeSupplierTaxId("NIT", "901944469-1")).toMatchObject({ ok: true, taxId: "901944469-1" });
  });

  it("un DV escrito que no corresponde es un NIT mal tecleado", () => {
    expect(normalizeSupplierTaxId("NIT", "901944469-7")).toEqual({ ok: false, error: "invalid_verification_digit" });
    expect(normalizeSupplierTaxId("NIT", "abc")).toEqual({ ok: false, error: "invalid_document" });
  });

  it("cédula y pasaporte: sólo el número, sin DV", () => {
    expect(normalizeSupplierTaxId("CC", "1.020.304.050")).toMatchObject({ ok: true, taxId: "1020304050", verificationDigit: null });
    expect(normalizeSupplierTaxId("PA", "ab 12345")).toMatchObject({ ok: true, taxId: "AB12345" });
    expect(normalizeSupplierTaxId("CC", "1020304050-3")).toEqual({ ok: false, error: "invalid_document" });
  });

  it("la clave de duplicados ignora puntos, espacios, prefijo NIT y DV", () => {
    expect(supplierTaxKey("NIT 900.123.456-7")).toBe("900123456");
    expect(supplierTaxKey("900123456")).toBe("900123456");
    expect(supplierTaxKey("  ")).toBeNull();
    expect(sameSupplierTaxId("900.123.456-7", "900123456")).toBe(true);
    expect(sameSupplierTaxId("900123456", "900123457")).toBe(false);
    expect(sameSupplierTaxId(null, null)).toBe(false);
    const list = [
      { id: "a", taxId: null },
      { id: "b", taxId: "800.200.300-1" },
    ];
    expect(findSupplierByTaxId(list, "800200300")?.id).toBe("b");
    expect(findSupplierByTaxId(list, "")).toBeNull();
  });

  it("tipo de persona por defecto: NIT → jurídica, cédula → natural", () => {
    expect(defaultPersonType("NIT")).toBe("juridica");
    expect(defaultPersonType("CC")).toBe("natural");
  });

  it("la exógena usa el tipo de documento y de persona explícitos cuando existen", () => {
    // Persona natural con NIT (no empieza por 8/9): antes salía como natural
    // por inferencia; ahora lo dice el alta.
    const explicit = supplierTercero({ id: "s1", name: "Ana Pérez", taxId: "52123456-0", taxIdType: "NIT", personType: "natural", address: null });
    expect(explicit).toMatchObject({ docType: "NIT", docNumber: "52123456", dvGiven: "0", kind: "natural" });
    const company = supplierTercero({ id: "s2", name: "ACME", taxId: "1234567", taxIdType: "NIT", personType: "juridica", address: null });
    expect(company).toMatchObject({ docType: "NIT", kind: "juridica" });
    // Sin campos explícitos: la inferencia de siempre.
    expect(supplierTercero({ id: "s3", name: "X", taxId: "900123456", address: null })).toMatchObject({ docType: "NIT", kind: "juridica" });
    expect(supplierTercero({ id: "s4", name: "Y", taxId: "1020304050", address: null })).toMatchObject({ docType: "CC", kind: "natural" });
  });
});
