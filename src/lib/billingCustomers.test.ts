import { describe, expect, it } from "vitest";
import { billingCustomerSchema } from "./billingCustomers";

// Sin dirección ni municipio: es lo que manda el formulario desde que la
// factura nominativa dejó de pedirlos.
const base = { customerName: "  Cliente de prueba  ", docType: "CC", docNumber: "1.020.304", email: "CLIENTE@example.test", phone: " 3001234567 " };
const withAddress = { ...base, address: " Calle 10 # 20-30 ", municipalityCode: "05001" };

describe("billingCustomerSchema", () => {
  it("normalizes identity and leaves address, municipality, city and department null when absent", () => {
    expect(billingCustomerSchema.parse({ ...base, city: "Bogotá", department: "Bogotá", restaurantId: "other" })).toEqual({ customerName: "Cliente de prueba", docType: "CC", docNumber: "1020304", verificationDigit: null, email: "cliente@example.test", phone: "3001234567", address: null, municipalityCode: null, city: null, department: null, country: "CO" });
  });
  it.each([{ address: "", municipalityCode: "" }, { address: null, municipalityCode: null }, { address: "   " }])("treats empty or null address and municipality as absent: %j", (extra) => {
    expect(billingCustomerSchema.parse({ ...base, ...extra })).toMatchObject({ address: null, municipalityCode: null, city: null, department: null });
  });
  it("still derives the municipality from the server catalog when a code is sent", () => {
    expect(billingCustomerSchema.parse({ ...withAddress, city: "Bogotá", department: "Bogotá" })).toMatchObject({ address: "Calle 10 # 20-30", municipalityCode: "05001", city: "Medellín", department: "Antioquia" });
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
  it.each([{ municipalityCode: "99999" }, { municipalityCode: "5001" }, { municipalityCode: "abcde" }, { address: "x" }, { docNumber: "12ABC34" }, { docNumber: "1-2345" }, { verificationDigit: "1" }, { customerName: "a" }, { email: "bad" }, { country: "US" }])("rejects invalid customer input: %j", (extra) => {
    expect(billingCustomerSchema.safeParse({ ...withAddress, ...extra }).success).toBe(false);
  });
  it("reports a present-but-invalid address or municipality on its own field", () => {
    const address = billingCustomerSchema.safeParse({ ...base, address: "x" });
    expect(address.success).toBe(false);
    expect(address.success ? [] : address.error.issues.map((i) => i.path.join("."))).toContain("address");
    const municipality = billingCustomerSchema.safeParse({ ...base, municipalityCode: "99999" });
    expect(municipality.success).toBe(false);
    expect(municipality.success ? [] : municipality.error.issues.map((i) => i.path.join("."))).toContain("municipalityCode");
  });
  it("supports passport numbers and optional phone", () => {
    expect(billingCustomerSchema.parse({ ...base, docType: "PA", docNumber: "ab 1234", phone: "" })).toMatchObject({ docNumber: "AB1234", phone: null });
  });
});
