// Regresiones del UBL contra las reglas que la DIAN devolvió el
// 2026-09-08 al validar el primer documento que le llegó de verdad.
// Cada test cita la regla que estaba fallando: si alguien rompe esto,
// la DIAN vuelve a rechazar.
import { describe, expect, it } from "vitest";
import {
  buildDianInvoiceXml,
  computeDianTotals,
  type DianInvoiceInput,
  type DianLine,
  type DianParty,
} from "./ubl";
import { orderToInvoiceLines } from "./emit";

const supplier: DianParty = {
  name: "SON Y MELONA S.A.S.",
  companyId: "901944469",
  dv: "1",
  idSchemeName: "31",
  taxLevelCode: "O-13",
  taxRegimeCode: "49",
  personType: "1",
  address: {
    cityCode: "05266",
    cityName: "Envigado",
    deptCode: "05",
    deptName: "Antioquia",
    line: "Cra 6 24A Sur 285",
  },
};

const consumidorFinal: DianParty = {
  name: "Consumidor final",
  companyId: "222222222222",
  idSchemeName: "13",
  taxLevelCode: "R-99-PN",
  taxRegimeCode: "49",
  personType: "2",
};

const line = (over: Partial<DianLine> = {}): DianLine => ({
  description: "Bandeja paisa",
  quantity: 1,
  unitPriceCents: 100_000,
  lineTotalCents: 100_000,
  taxCents: 8_000,
  taxPct: "8.00",
  taxSchemeId: "04",
  ...over,
});

function build(lines: DianLine[], customer: DianParty = consumidorFinal) {
  const input: DianInvoiceInput = {
    environment: "2",
    softwareId: "soft-1",
    softwarePin: "1234",
    technicalKey: "clave-tecnica",
    resolution: {
      number: "18760000001",
      startDate: "2026-01-01",
      endDate: "2027-01-01",
      prefix: "FE",
      from: 1,
      to: 5000,
    },
    invoiceNumber: "FE1",
    issueDate: "2026-09-08",
    issueTime: "15:04:05-05:00",
    supplier,
    customer,
    lines,
    paymentMeansCode: "10",
  };
  return buildDianInvoiceXml(input);
}

/** Suma de los TaxableAmount que aparecen dentro de las InvoiceLine. */
function lineTaxableAmounts(xml: string): number[] {
  const lines = xml.split("<cac:InvoiceLine>").slice(1);
  const out: number[] = [];
  for (const l of lines) {
    const m = l.match(/<cbc:TaxableAmount currencyID="COP">([\d.]+)<\/cbc:TaxableAmount>/);
    if (m) out.push(Number(m[1]));
  }
  return out;
}

function legalTotal(xml: string, tag: string): number {
  const block = xml.split("<cac:LegalMonetaryTotal>")[1] ?? "";
  const m = block.match(new RegExp(`<cbc:${tag} currencyID="COP">([\\d.]+)<`));
  return m ? Number(m[1]) : NaN;
}

describe("FAU04 — base imponible del documento vs. suma de las líneas", () => {
  it("con líneas gravadas y excluidas mezcladas, la base es sólo la gravada", () => {
    const { xml, totals } = build([
      line({ lineTotalCents: 100_000, taxCents: 8_000 }),
      line({ description: "Agua", lineTotalCents: 50_000, taxCents: 0, taxPct: "0.00" }),
    ]);
    const sumLines = lineTaxableAmounts(xml).reduce((a, b) => a + b, 0);
    expect(legalTotal(xml, "TaxExclusiveAmount")).toBe(sumLines);
    // El bruto sigue incluyendo la línea excluida.
    expect(legalTotal(xml, "LineExtensionAmount")).toBe(1500);
    expect(totals.taxableBaseCents).toBe(100_000);
  });

  it("sin ninguna línea gravada la base imponible es cero, no el bruto", () => {
    const { xml } = build([line({ taxCents: 0, taxPct: "0.00" })]);
    expect(lineTaxableAmounts(xml)).toEqual([]);
    expect(legalTotal(xml, "TaxExclusiveAmount")).toBe(0);
    expect(legalTotal(xml, "PayableAmount")).toBe(1000);
  });

  it("con dos tarifas del mismo impuesto hay un TaxSubtotal por tarifa", () => {
    const { xml } = build([
      line({ taxSchemeId: "01", taxPct: "19.00", lineTotalCents: 100_000, taxCents: 19_000 }),
      line({ taxSchemeId: "01", taxPct: "5.00", lineTotalCents: 200_000, taxCents: 10_000 }),
    ]);
    const docBlock = xml.split("<cac:PaymentMeans>")[1].split("<cac:LegalMonetaryTotal>")[0];
    expect(docBlock.match(/<cac:TaxSubtotal>/g)?.length).toBe(2);
    expect(docBlock).toContain("<cbc:Percent>19.00</cbc:Percent>");
    expect(docBlock).toContain("<cbc:Percent>5.00</cbc:Percent>");
    // Y la base del documento sigue cuadrando con el detalle.
    const sumLines = lineTaxableAmounts(xml).reduce((a, b) => a + b, 0);
    expect(legalTotal(xml, "TaxExclusiveAmount")).toBe(sumLines);
  });

  it("computeDianTotals separa bruto de base imponible", () => {
    const t = computeDianTotals([
      line({ lineTotalCents: 100_000, taxCents: 8_000 }),
      line({ lineTotalCents: 50_000, taxCents: 0 }),
    ]);
    expect(t.lineExtensionCents).toBe(150_000);
    expect(t.taxableBaseCents).toBe(100_000);
    expect(t.taxIncCents).toBe(8_000);
    expect(t.payableCents).toBe(158_000);
  });
});

describe("FAD03 — ProfileID literal", () => {
  it("usa el literal exacto que la DIAN compara", () => {
    const { xml } = build([line()]);
    expect(xml).toContain(
      "<cbc:ProfileID>DIAN 2.1: Factura Electrónica de Venta</cbc:ProfileID>",
    );
  });
});

describe("FAJ24 / FAJ24a / FAJ47 / FAB22a / FAB22b — DV del NIT", () => {
  it("el DV del emisor va en @schemeID de cada CompanyID", () => {
    const { xml } = build([line()]);
    const supplierBlock = xml.split("<cac:AccountingSupplierParty>")[1];
    expect(supplierBlock).toContain('<cbc:CompanyID schemeID="1" schemeName="31"');
    expect(supplierBlock.match(/schemeID="1" schemeName="31"/g)?.length).toBe(2);
  });

  it("el Prestador de Servicios (software propio) lleva el mismo NIT con DV", () => {
    const { xml } = build([line()]);
    expect(xml).toContain('schemeID="1" schemeName="31">901944469</sts:ProviderID>');
  });

  it("el adquirente con cédula NO lleva DV", () => {
    const { xml } = build([line()]);
    const customerBlock = xml
      .split("<cac:AccountingCustomerParty>")[1]
      .split("</cac:AccountingCustomerParty>")[0];
    expect(customerBlock).toContain('<cbc:CompanyID schemeName="13"');
    expect(customerBlock).not.toContain("schemeID=");
  });
});

// El grupo que pide FAK61 es cac:PartyIdentification (Anexo Técnico 1.9,
// Resolución 000165/2023: FAK61 grupo, FAK62 cbc:ID, FAK63 @schemeName,
// FAK64 @schemeID). NO es cac:Person: ese grupo sólo existe en el
// ApplicationResponse del acuse de recibo (AAH12), no en la factura.
describe("FAK61 — grupo cac:PartyIdentification cuando AdditionalAccountID es 2", () => {
  it("la persona natural informa el documento en cac:PartyIdentification", () => {
    const { xml } = build([line()]);
    const customerBlock = xml
      .split("<cac:AccountingCustomerParty>")[1]
      .split("</cac:AccountingCustomerParty>")[0];
    expect(customerBlock).toContain("<cbc:AdditionalAccountID>2</cbc:AdditionalAccountID>");
    expect(customerBlock).toContain("<cac:PartyIdentification>");
    // FAK62/FAK63: documento del consumidor final y su tipo.
    expect(customerBlock).toContain(
      '<cbc:ID schemeName="13" schemeAgencyID="195" schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)">222222222222</cbc:ID>',
    );
  });

  it("cac:PartyIdentification abre cac:Party, antes de PartyName", () => {
    const { xml } = build([line()]);
    const party = xml
      .split("<cac:AccountingCustomerParty>")[1]
      .split("</cac:AccountingCustomerParty>")[0]
      .split("<cac:Party>")[1];
    expect(party.indexOf("<cac:PartyIdentification>")).toBe(0);
    expect(party.indexOf("<cac:PartyIdentification>")).toBeLessThan(
      party.indexOf("<cac:PartyName>"),
    );
  });

  it("con NIT el DV viaja en @schemeID del cbc:ID", () => {
    const { xml } = build([line()], {
      ...consumidorFinal,
      name: "Persona natural con NIT",
      companyId: "1020304050",
      dv: "7",
      idSchemeName: "31",
    });
    const customerBlock = xml
      .split("<cac:AccountingCustomerParty>")[1]
      .split("</cac:AccountingCustomerParty>")[0];
    expect(customerBlock).toContain(
      '<cac:PartyIdentification><cbc:ID schemeID="7" schemeName="31"',
    );
  });

  it("la persona jurídica no lleva el grupo", () => {
    const { xml } = build([line()]);
    const supplierBlock = xml
      .split("<cac:AccountingSupplierParty>")[1]
      .split("</cac:AccountingSupplierParty>")[0];
    expect(supplierBlock).toContain("<cbc:AdditionalAccountID>1</cbc:AdditionalAccountID>");
    expect(supplierBlock).not.toContain("<cac:PartyIdentification>");
  });

  it("no se emite cac:Person: no existe en la factura del anexo", () => {
    const { xml } = build([line()]);
    expect(xml).not.toContain("<cac:Person>");
  });
});

describe("FAZ09 — identificación del bien o servicio", () => {
  it("cada línea trae StandardItemIdentification", () => {
    const { xml } = build([line(), line({ description: "Jugo", itemCode: "JUGO-1" })]);
    expect(xml.match(/<cac:StandardItemIdentification>/g)?.length).toBe(2);
    expect(xml).toContain('<cbc:ID schemeID="999"');
    expect(xml).toContain(">JUGO-1</cbc:ID>");
  });
});

describe("orderToInvoiceLines — impuesto por línea", () => {
  const item = (over: Partial<Parameters<typeof orderToInvoiceLines>[0][number]> = {}) => ({
    nameSnapshot: "Bandeja",
    qty: 1,
    priceCentsSnapshot: 30_000_00,
    cancelledAt: null,
    taxKind: null as string | null,
    taxPct: null as number | null,
    ...over,
  });

  it("plato de carta: impuesto EMBEBIDO con la tarifa del comercio", () => {
    const [l] = orderToInvoiceLines([item()], { kind: "inc", pct: 8 });
    expect(l.lineTotalCents + l.taxCents).toBe(30_000_00);
    expect(l.taxSchemeId).toBe("04");
    expect(l.taxPct).toBe("8.00");
  });

  it("línea libre: impuesto SUMADO encima con su propia tarifa", () => {
    const [l] = orderToInvoiceLines(
      [item({ priceCentsSnapshot: 2_400_000_00, taxKind: "iva", taxPct: 19 })],
      { kind: "inc", pct: 8 },
    );
    expect(l.lineTotalCents).toBe(2_400_000_00);
    expect(l.taxCents).toBe(456_000_00);
    expect(l.taxSchemeId).toBe("01");
    expect(l.taxPct).toBe("19.00");
  });

  it("cuenta mixta: cada línea conserva su régimen y el total cuadra", () => {
    const lines = orderToInvoiceLines(
      [
        item(),
        item({ priceCentsSnapshot: 100_000_00, taxKind: "iva", taxPct: 19 }),
        item({ priceCentsSnapshot: 10_000_00, taxKind: "none", taxPct: 0 }),
      ],
      { kind: "inc", pct: 8 },
    );
    expect(lines.map((l) => l.taxSchemeId)).toEqual(["04", "01", "01"]);
    const { xml } = build(lines);
    const sumLines = lineTaxableAmounts(xml).reduce((a, b) => a + b, 0);
    expect(legalTotal(xml, "TaxExclusiveAmount")).toBe(sumLines);
  });

  it("comercio sin impuesto: nada se descuenta del precio", () => {
    const [l] = orderToInvoiceLines([item()], { kind: "none", pct: 0 });
    expect(l.lineTotalCents).toBe(30_000_00);
    expect(l.taxCents).toBe(0);
  });

  it("ignora los items cancelados", () => {
    const lines = orderToInvoiceLines(
      [item({ cancelledAt: new Date() }), item()],
      { kind: "none", pct: 0 },
    );
    expect(lines).toHaveLength(1);
  });
});
