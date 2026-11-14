import { describe, expect, it } from "vitest";
import { computeCuds, cudsPlainText } from "./cuds";

// Ejemplo oficial: Anexo Técnico DS v1.1, §14.1, págs. 214-215.
const ANEXO = {
  documentNumber: "0000000001",
  issueDate: "2020-10-24",
  issueTime: "14:04:35-05:00",
  lineExtensionAmount: "15000.00",
  ivaAmount: "19.00",
  payableAmount: "16350.00",
  sellerId: "900373076",
  buyerNit: "8355990",
  softwarePin: "12345",
  environment: "1" as const,
};

describe("CUDS (anexo DS §14.1)", () => {
  it("concatena en el orden del anexo: vendedor (NumSNO) antes que adquiriente (NITABS)", () => {
    expect(cudsPlainText(ANEXO)).toBe(
      "00000000012020-10-2414:04:35-05:0015000.000119.0016350.009003730768355990123451",
    );
  });

  it("reproduce el CUDS del ejemplo oficial", () => {
    expect(computeCuds(ANEXO)).toBe(
      "bf4bb6920d5054ac065ddb7e6df0398e63e3ba2ff29cb341edd7d46ee8f2ea1802f84aaca91a19a24623e5e3baff3a71",
    );
  });

  it("cambia con el ambiente y con el PIN (nunca con la clave técnica)", () => {
    const base = computeCuds(ANEXO);
    expect(computeCuds({ ...ANEXO, environment: "2" })).not.toBe(base);
    expect(computeCuds({ ...ANEXO, softwarePin: "54321" })).not.toBe(base);
  });
});
