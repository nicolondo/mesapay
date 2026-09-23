import { describe, expect, it } from "vitest";
import { billingDocument, billingLocation } from "./types";

describe("billingDocument", () => {
  it("un NIT se muestra SIN el dígito de verificación aunque esté guardado", () => {
    expect(billingDocument({ docType: "NIT", docNumber: "901944469", verificationDigit: "1" })).toBe("901944469");
  });
  it("los demás documentos se muestran tal cual", () => {
    expect(billingDocument({ docType: "CC", docNumber: "1020304050", verificationDigit: null })).toBe("1020304050");
    expect(billingDocument({ docType: "PA", docNumber: "AB1234", verificationDigit: null })).toBe("AB1234");
  });
});

describe("billingLocation", () => {
  it("arma dirección · ciudad, departamento con lo que haya", () => {
    expect(billingLocation({ address: "Calle 10 # 20-30", city: "Medellín", department: "Antioquia" })).toBe("Calle 10 # 20-30 · Medellín, Antioquia");
    expect(billingLocation({ address: null, city: null, department: null })).toBe("");
  });
});
