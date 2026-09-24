// Factura de una cuenta cobrada a crédito: forma de pago "2" (crédito),
// medio "1" (instrumento no definido) y vencimiento = emisión + plazo.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import { creditPaymentMeans } from "./emit";
import { buildDianInvoiceXml, type DianInvoiceInput, type DianParty } from "./ubl";

describe("creditPaymentMeans", () => {
  it("sin cobro a crédito: contado en efectivo, como siempre", () => {
    expect(creditPaymentMeans([], "2026-09-23")).toEqual({ paymentMeansCode: "10" });
    expect(creditPaymentMeans([{ billingCustomer: null }], "2026-09-23")).toEqual({ paymentMeansCode: "10" });
  });
  it("con cobro a crédito: forma 2, medio 1 y vence a los días de plazo del cliente", () => {
    expect(creditPaymentMeans([{ billingCustomer: { creditTermsDays: 30 } }], "2026-09-23")).toEqual({
      paymentMeansCode: "1",
      paymentMeansId: "2",
      paymentDueDate: "2026-10-23",
    });
    // Cruza el año y tolera plazo 0 (vence el mismo día).
    expect(creditPaymentMeans([{ billingCustomer: { creditTermsDays: 100 } }], "2026-12-01").paymentDueDate).toBe("2027-03-11");
    expect(creditPaymentMeans([{ billingCustomer: { creditTermsDays: 0 } }], "2026-09-23").paymentDueDate).toBe("2026-09-23");
  });
});

describe("PaymentMeans en el XML", () => {
  const party: DianParty = {
    name: "Consumidor final",
    companyId: "222222222222",
    idSchemeName: "13",
    taxLevelCode: "R-99-PN",
    taxRegimeCode: "49",
    personType: "2",
  };
  const base: DianInvoiceInput = {
    environment: "2",
    softwareId: "soft-1",
    softwarePin: "1234",
    technicalKey: "clave-tecnica",
    resolution: { number: "18760000001", startDate: "2026-01-01", endDate: "2027-01-01", prefix: "FE", from: 1, to: 5000 },
    invoiceNumber: "FE1",
    issueDate: "2026-09-08",
    issueTime: "15:04:05-05:00",
    supplier: { ...party, name: "Emisor", companyId: "901944469", dv: "1", idSchemeName: "31", personType: "1" },
    customer: party,
    lines: [{ description: "Bandeja", quantity: 1, unitPriceCents: 100_000, lineTotalCents: 100_000, taxCents: 8_000, taxPct: "8.00", taxSchemeId: "04" }],
    paymentMeansCode: "10",
  };
  const means = (input: DianInvoiceInput) => buildDianInvoiceXml(input).xml.split("<cac:PaymentMeans>")[1].split("</cac:PaymentMeans>")[0];

  it("por defecto sigue saliendo contado con vencimiento el día de emisión", () => {
    expect(means(base)).toBe("<cbc:ID>1</cbc:ID><cbc:PaymentMeansCode>10</cbc:PaymentMeansCode><cbc:PaymentDueDate>2026-09-08</cbc:PaymentDueDate><cbc:PaymentID>1</cbc:PaymentID>");
  });
  it("a crédito lleva forma de pago 2 y la fecha de vencimiento", () => {
    expect(means({ ...base, ...creditPaymentMeans([{ billingCustomer: { creditTermsDays: 15 } }], base.issueDate) })).toBe(
      "<cbc:ID>2</cbc:ID><cbc:PaymentMeansCode>1</cbc:PaymentMeansCode><cbc:PaymentDueDate>2026-09-23</cbc:PaymentDueDate><cbc:PaymentID>1</cbc:PaymentID>",
    );
  });
});
