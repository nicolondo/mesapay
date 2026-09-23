import { describe, expect, it } from "vitest";
import { compactDocumentNumber, normalizeCustomerDocument } from "./customerDocument";

// El NIT de Son y Melona: 901944469, DV 1.
describe("normalizeCustomerDocument", () => {
  it("NIT sin DV: se calcula y el número queda sin él", () => {
    expect(normalizeCustomerDocument("NIT", "901944469")).toEqual({ ok: true, docNumber: "901944469", verificationDigit: "1" });
    expect(normalizeCustomerDocument("NIT", " 901.944.469 ")).toEqual({ ok: true, docNumber: "901944469", verificationDigit: "1" });
  });
  it.each(["901944469-1", "901.944.469-1"])("NIT con el DV correcto escrito (%s): se separa y se respeta", (raw) => {
    expect(normalizeCustomerDocument("NIT", raw)).toEqual({ ok: true, docNumber: "901944469", verificationDigit: "1" });
  });
  it("el DV que llega por un campo aparte se contrasta igual", () => {
    expect(normalizeCustomerDocument("NIT", "901944469", "1")).toMatchObject({ ok: true, verificationDigit: "1" });
    expect(normalizeCustomerDocument("NIT", "901944469", "2")).toEqual({ ok: false, error: "invalid_verification_digit" });
  });
  it.each(["901944469-2", "901944469-0"])("NIT con un DV que no corresponde (%s): se rechaza", (raw) => {
    expect(normalizeCustomerDocument("NIT", raw)).toEqual({ ok: false, error: "invalid_verification_digit" });
  });
  it("nunca recorta el último dígito de un NIT sin separador: puede ser otro NIT", () => {
    expect(normalizeCustomerDocument("NIT", "9019444691")).toMatchObject({ ok: true, docNumber: "9019444691" });
  });
  it.each(["12ABC34", "1-2345", "901944469-", "901944469-12", "123"])("NIT con forma inválida (%s)", (raw) => {
    expect(normalizeCustomerDocument("NIT", raw)).toEqual({ ok: false, error: "invalid_document" });
  });
  it("cédula: sólo dígitos, sin puntos; un DV suelto es un error", () => {
    expect(normalizeCustomerDocument("CC", "1.020.304.050")).toEqual({ ok: true, docNumber: "1020304050", verificationDigit: null });
    expect(normalizeCustomerDocument("CC", "1020304050-1")).toEqual({ ok: false, error: "invalid_document" });
    expect(normalizeCustomerDocument("CC", "1020304050", "1")).toEqual({ ok: false, error: "invalid_document" });
    expect(normalizeCustomerDocument("CC", "AB1234")).toEqual({ ok: false, error: "invalid_document" });
  });
  it("cédula de extranjería y pasaporte: alfanumérico en mayúsculas", () => {
    expect(normalizeCustomerDocument("PA", "ab 1234")).toEqual({ ok: true, docNumber: "AB1234", verificationDigit: null });
    expect(normalizeCustomerDocument("CE", "x-1")).toEqual({ ok: false, error: "invalid_document" });
  });
  it("compactDocumentNumber quita puntos y espacios y pasa a mayúsculas", () => {
    expect(compactDocumentNumber(" 901.944 469-1 ")).toBe("901944469-1");
    expect(compactDocumentNumber("ab 12")).toBe("AB12");
  });
});
