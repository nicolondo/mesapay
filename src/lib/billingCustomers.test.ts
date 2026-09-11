import { describe, expect, it } from "vitest";
import { billingCustomerSchema } from "./billingCustomers";

const base = { customerName: "  Cliente de prueba  ", docType: "CC", docNumber: "1.020.304", email: "CLIENTE@example.test", phone: " 3001234567 ", address: " Calle 10 # 20-30 ", municipalityCode: "05001" };

describe("billingCustomerSchema", () => {
  it("normalizes identity and derives the municipality from the server catalog", () => {
    expect(billingCustomerSchema.parse({ ...base, city: "Bogotá", department: "Bogotá", restaurantId: "other" })).toEqual({ customerName: "Cliente de prueba", docType: "CC", docNumber: "1020304", verificationDigit: null, email: "cliente@example.test", phone: "3001234567", address: "Calle 10 # 20-30", municipalityCode: "05001", city: "Medellín", department: "Antioquia", country: "CO" });
  });
  it.each([{}, { verificationDigit: "1" }, { docNumber: "901.944.469-1" }])("stores NIT and DV separately: %j", (extra) => {
    expect(billingCustomerSchema.parse({ ...base, docType: "NIT", docNumber: "901944469", ...extra })).toMatchObject({ docNumber: "901944469", verificationDigit: "1" });
  });
  it.each([{ docNumber: "901944469-2" }, { verificationDigit: "2" }, { docNumber: "901944469-1", verificationDigit: "2" }])("rejects incorrect or conflicting NIT DV: %j", (extra) => {
    expect(billingCustomerSchema.safeParse({ ...base, docType: "NIT", docNumber: "901944469", ...extra }).success).toBe(false);
  });
  it("never strips an ambiguous last digit from a NIT without a separator", () => {
    expect(billingCustomerSchema.parse({ ...base, docType: "NIT", docNumber: "9019444691" }).docNumber).toBe("9019444691");
  });
  it.each([{ municipalityCode: "99999" }, { docNumber: "12ABC34" }, { docNumber: "1-2345" }, { verificationDigit: "1" }, { customerName: "a" }, { email: "bad" }, { address: "x" }, { country: "US" }])("rejects invalid customer input: %j", (extra) => {
    expect(billingCustomerSchema.safeParse({ ...base, ...extra }).success).toBe(false);
  });
  it("supports passport numbers and optional phone", () => {
    expect(billingCustomerSchema.parse({ ...base, docType: "PA", docNumber: "ab 1234", phone: "" })).toMatchObject({ docNumber: "AB1234", phone: null });
  });
});
