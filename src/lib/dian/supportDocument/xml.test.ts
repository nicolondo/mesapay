import { DOMParser } from "@xmldom/xmldom";
import { describe, expect, it } from "vitest";
import { computeCuds } from "./cuds";
import { BUYER, FOREIGN_SELLER, line, RESIDENT_SELLER, RESOLUTION } from "./__fixtures__/supportDoc";
import { buildAdjustmentNoteXml, buildSupportDocumentXml, computeSupportDocTotals } from "./xml";

const COMMON = {
  environment: "2" as const,
  softwareId: "sw-ds-prueba",
  softwarePin: "12345",
  documentNumber: "DS1000",
  issueDate: "2026-11-13",
  issueTime: "10:00:00-05:00",
  customizationId: "10" as const,
  seller: RESIDENT_SELLER,
  buyer: BUYER,
  paymentMeans: { id: "1" as const, code: "1", dueDate: null },
};

function parse(xml: string): Element {
  return new DOMParser().parseFromString(xml, "text/xml").documentElement as unknown as Element;
}

/** Hijos elemento directos (nombre local), en orden. */
function childNames(el: Element): string[] {
  const out: string[] = [];
  for (let i = 0; i < el.childNodes.length; i++) {
    const c = el.childNodes.item(i)!;
    if (c.nodeType === 1) out.push((c as Element).localName!);
  }
  return out;
}

function first(el: Element, local: string): Element {
  const found = el.getElementsByTagNameNS("*", local).item(0);
  if (!found) throw new Error(`no ${local}`);
  return found as unknown as Element;
}

const WITH_TAXES = [
  line({
    description: "Insumo con IVA",
    unitPriceCents: 1_000_000,
    lineTotalCents: 1_000_000,
    ivaCents: 190_000,
    ivaPct: "19.00",
    withholdings: [
      { schemeId: "06", taxableCents: 1_000_000, amountCents: 25_000, pct: "2.50" },
      { schemeId: "05", taxableCents: 190_000, amountCents: 28_500, pct: "15.00" },
    ],
  }),
  line({
    description: "Servicio sin IVA",
    itemCode: "G-2",
    unitPriceCents: 500_000,
    lineTotalCents: 500_000,
    withholdings: [{ schemeId: "06", taxableCents: 500_000, amountCents: 12_500, pct: "2.50" }],
  }),
];

describe("buildSupportDocumentXml", () => {
  it("snapshot de un DS residente con IVA y retenciones", () => {
    const built = buildSupportDocumentXml({ ...COMMON, resolution: RESOLUTION, lines: WITH_TAXES });
    expect(built.xml).toMatchSnapshot();
  });

  it("encabezado exacto del anexo: tipo 05, CustomizationID, ProfileID y CUDS", () => {
    const built = buildSupportDocumentXml({ ...COMMON, resolution: RESOLUTION, lines: [line()] });
    const root = parse(built.xml);
    expect(root.localName).toBe("Invoice");
    expect(first(root, "InvoiceTypeCode").textContent).toBe("05");
    expect(first(root, "CustomizationID").textContent).toBe("10");
    expect(first(root, "ProfileID").textContent).toBe(
      "DIAN 2.1: documento soporte en adquisiciones efectuadas a no obligados a facturar.",
    );
    const uuid = first(root, "UUID");
    expect(uuid.getAttribute("schemeName")).toBe("CUDS-SHA384");
    expect(uuid.getAttribute("schemeID")).toBe("2");
    expect(uuid.textContent).toBe(built.cuds);
    expect(first(root, "QRCode").textContent).toBe(
      `https://catalogo-vpfe-hab.dian.gov.co/document/searchqr?documentkey=${built.cuds}`,
    );
  });

  it("orden de los hijos del Invoice según el esquema UBL 2.1", () => {
    const root = parse(buildSupportDocumentXml({ ...COMMON, resolution: RESOLUTION, lines: WITH_TAXES }).xml);
    expect(childNames(root)).toEqual([
      "UBLExtensions",
      "UBLVersionID",
      "CustomizationID",
      "ProfileID",
      "ProfileExecutionID",
      "ID",
      "UUID",
      "IssueDate",
      "IssueTime",
      "InvoiceTypeCode",
      "DocumentCurrencyCode",
      "LineCountNumeric",
      "AccountingSupplierParty",
      "AccountingCustomerParty",
      "PaymentMeans",
      "TaxTotal",
      "WithholdingTaxTotal",
      "WithholdingTaxTotal",
      "LegalMonetaryTotal",
      "InvoiceLine",
      "InvoiceLine",
    ]);
    const lineEl = root.getElementsByTagNameNS("*", "InvoiceLine").item(0) as unknown as Element;
    expect(childNames(lineEl)).toEqual([
      "ID",
      "InvoicedQuantity",
      "LineExtensionAmount",
      "InvoicePeriod",
      "TaxTotal",
      "WithholdingTaxTotal",
      "WithholdingTaxTotal",
      "Item",
      "Price",
    ]);
  });

  it("roles invertidos: el vendedor no obligado es el SupplierParty con NIT, DV y dirección completa", () => {
    const root = parse(buildSupportDocumentXml({ ...COMMON, resolution: RESOLUTION, lines: [line()] }).xml);
    const supplier = first(root, "AccountingSupplierParty");
    const companyId = first(supplier, "CompanyID");
    expect(companyId.textContent).toBe("1020304050");
    expect(companyId.getAttribute("schemeName")).toBe("31");
    expect(companyId.getAttribute("schemeID")).toBe("1");
    expect(first(supplier, "PostalZone").textContent).toBe("055422");
    expect(first(supplier, "AdditionalAccountID").textContent).toBe("2");
    // v1.1 eliminó PartyLegalEntity y Contact del vendedor.
    expect(supplier.getElementsByTagNameNS("*", "PartyLegalEntity").length).toBe(0);
    expect(supplier.getElementsByTagNameNS("*", "Contact").length).toBe(0);
    const customer = first(root, "AccountingCustomerParty");
    expect(first(customer, "CompanyID").textContent).toBe("900373076");
    expect(customer.getElementsByTagNameNS("*", "PhysicalLocation").length).toBe(0);
    // Software propio: el proveedor del software es el mismo adquiriente.
    expect(first(root, "ProviderID").textContent).toBe("900373076");
  });

  it("InvoicePeriod de cada línea con fecha de compra y forma de generación", () => {
    const root = parse(
      buildSupportDocumentXml({
        ...COMMON,
        resolution: RESOLUTION,
        lines: [line({ purchaseDate: "2026-11-10", generationForm: "2" })],
      }).xml,
    );
    const period = first(root, "InvoicePeriod");
    expect(first(period, "StartDate").textContent).toBe("2026-11-10");
    expect(first(period, "DescriptionCode").textContent).toBe("2");
    expect(first(period, "Description").textContent).toBe("Acumulado semanal");
  });

  it("totales: las retenciones no tocan el PayableAmount y el CUDS usa el IVA del documento", () => {
    const built = buildSupportDocumentXml({ ...COMMON, resolution: RESOLUTION, lines: WITH_TAXES });
    expect(built.totals).toEqual({
      lineExtensionCents: 1_500_000,
      taxableBaseCents: 1_000_000,
      ivaCents: 190_000,
      payableCents: 1_690_000,
      withholdingCents: 66_000,
    });
    const root = parse(built.xml);
    const lmt = first(root, "LegalMonetaryTotal");
    expect(first(lmt, "PayableAmount").textContent).toBe("16900.00");
    expect(first(lmt, "TaxExclusiveAmount").textContent).toBe("10000.00");
    expect(built.cuds).toBe(
      computeCuds({
        documentNumber: "DS1000",
        issueDate: "2026-11-13",
        issueTime: "10:00:00-05:00",
        lineExtensionAmount: "15000.00",
        ivaAmount: "1900.00",
        payableAmount: "16900.00",
        sellerId: "1020304050",
        buyerNit: "900373076",
        softwarePin: "12345",
        environment: "2",
      }),
    );
    // Retención de renta del documento = Σ líneas, una por tributo.
    const docWithholdings = childNames(root).filter((n) => n === "WithholdingTaxTotal").length;
    expect(docWithholdings).toBe(2);
  });

  it("sin IVA no hay TaxTotal y la base imponible es 0", () => {
    const built = buildSupportDocumentXml({ ...COMMON, resolution: RESOLUTION, lines: [line()] });
    const root = parse(built.xml);
    expect(childNames(root)).not.toContain("TaxTotal");
    expect(first(first(root, "LegalMonetaryTotal"), "TaxExclusiveAmount").textContent).toBe("0.00");
  });

  it("vendedor no residente: CustomizationID 11, sin código DANE ni DV", () => {
    const built = buildSupportDocumentXml({
      ...COMMON,
      customizationId: "11",
      seller: FOREIGN_SELLER,
      resolution: RESOLUTION,
      lines: [line()],
    });
    const root = parse(built.xml);
    expect(first(root, "CustomizationID").textContent).toBe("11");
    const address = first(first(root, "AccountingSupplierParty"), "Address");
    expect(childNames(address)).toEqual(["CityName", "Country"]);
    expect(first(address, "IdentificationCode").textContent).toBe("US");
    const companyId = first(first(root, "AccountingSupplierParty"), "CompanyID");
    expect(companyId.getAttribute("schemeName")).toBe("50");
    expect(companyId.hasAttribute("schemeID")).toBe(false);
  });

  it("escapa el texto libre", () => {
    const built = buildSupportDocumentXml({
      ...COMMON,
      resolution: RESOLUTION,
      lines: [line({ description: 'Tornillos <3/8"> & tuercas' })],
    });
    expect(built.xml).toContain("Tornillos &lt;3/8&quot;&gt; &amp; tuercas");
  });

  it("rechaza números con espacios o guiones (DSAD05a)", () => {
    expect(() =>
      buildSupportDocumentXml({ ...COMMON, documentNumber: "DS-1000", resolution: RESOLUTION, lines: [line()] }),
    ).toThrow("support_doc_invalid_number");
  });
});

describe("buildAdjustmentNoteXml", () => {
  const NOTE = {
    ...COMMON,
    documentNumber: "NAS1",
    lines: WITH_TAXES,
    reference: { documentNumber: "DS1000", cuds: "a".repeat(96), issueDate: "2026-11-13" },
    reasonCode: "2" as const,
    reasonText: "Anulación: el gasto se registró dos veces",
  };

  it("snapshot de una nota de ajuste de anulación", () => {
    expect(buildAdjustmentNoteXml(NOTE).xml).toMatchSnapshot();
  });

  it("CreditNote tipo 95 sin InvoiceControl ni retenciones, con referencia al DS", () => {
    const built = buildAdjustmentNoteXml(NOTE);
    const root = parse(built.xml);
    expect(root.localName).toBe("CreditNote");
    expect(first(root, "CreditNoteTypeCode").textContent).toBe("95");
    expect(root.getElementsByTagNameNS("*", "InvoiceControl").length).toBe(0);
    expect(root.getElementsByTagNameNS("*", "WithholdingTaxTotal").length).toBe(0);
    expect(first(root, "ResponseCode").textContent).toBe("2");
    expect(first(root, "Description").textContent).toBe("Anulación: el gasto se registró dos veces");
    const ref = first(root, "InvoiceDocumentReference");
    expect(first(ref, "ID").textContent).toBe("DS1000");
    expect(first(ref, "UUID").getAttribute("schemeName")).toBe("CUDS-SHA384");
    expect(childNames(root).slice(0, 14)).toEqual([
      "UBLExtensions",
      "UBLVersionID",
      "CustomizationID",
      "ProfileID",
      "ProfileExecutionID",
      "ID",
      "UUID",
      "IssueDate",
      "IssueTime",
      "CreditNoteTypeCode",
      "DocumentCurrencyCode",
      "LineCountNumeric",
      "DiscrepancyResponse",
      "BillingReference",
    ]);
    const lineEl = root.getElementsByTagNameNS("*", "CreditNoteLine").item(0) as unknown as Element;
    expect(childNames(lineEl)).toEqual(["ID", "CreditedQuantity", "LineExtensionAmount", "TaxTotal", "Item", "Price"]);
    expect(built.totals.withholdingCents).toBe(0);
    expect(built.totals.payableCents).toBe(1_690_000);
  });
});

describe("computeSupportDocTotals", () => {
  it("suma exacta de enteros", () => {
    expect(computeSupportDocTotals([line({ lineTotalCents: 1, ivaCents: 0 })]).payableCents).toBe(1);
  });
});
