// La emisión como librería: el adquiriente que viaja en el XML, el CUFE
// que se calcula con ESE mismo adquiriente, y los guards que frenan antes
// de gastar un consecutivo. Los mocks sustituyen sólo lo que tocaría DB,
// certificados o la red; el builder UBL, el CUFE y los guards corren de
// verdad.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  resolveEmisor: vi.fn(),
  loadDianConfig: vi.fn(),
  invoiceFindUnique: vi.fn(),
  docFindUnique: vi.fn(),
  docCreate: vi.fn(),
  docUpdate: vi.fn(),
  signXmlDian: vi.fn(),
  zipInvoice: vi.fn(),
  sendBillSync: vi.fn(),
  sendTestSetAsync: vi.fn(),
  sendDianInvoiceEmail: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({
  db: {
    simpleInvoice: { findUnique: m.invoiceFindUnique },
    dianDocument: {
      findUnique: m.docFindUnique,
      create: m.docCreate,
      update: m.docUpdate,
    },
  },
}));
vi.mock("@/lib/dian/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dian/config")>()),
  resolveEmisor: m.resolveEmisor,
  loadDianConfig: m.loadDianConfig,
}));
vi.mock("@/lib/dian/xades", () => ({ signXmlDian: m.signXmlDian }));
vi.mock("@/lib/dian/soap", () => ({
  zipInvoice: m.zipInvoice,
  sendBillSync: m.sendBillSync,
  sendTestSetAsync: m.sendTestSetAsync,
}));
vi.mock("@/lib/dian/sendInvoiceEmail", () => ({
  sendDianInvoiceEmail: m.sendDianInvoiceEmail,
}));

import { emitDianInvoice } from "./emitInvoice";
import { computeCufe } from "./crypto";
import type { EmisorData } from "./config";

// Son & Melona: prefijo FESM, resolución 18764094877213, rango 1..10000.
function emisor(over: Partial<EmisorData> = {}): EmisorData {
  return {
    ref: { kind: "restaurant", id: "rest-1" },
    legalName: "SON Y MELONA S.A.S.",
    taxId: "901944469-1",
    addressLine: "CR 6 24 A SUR 285 LC 112",
    cityName: "ENVIGADO",
    legalCityCode: "05266",
    resolution: null,
    resolutionFrom: 1,
    resolutionTo: 10000,
    resolutionNumber: "18764094877213",
    resolutionValidFrom: "2025-06-26",
    resolutionValidTo: "2030-06-26",
    resolutionDate: "2025-06-26",
    invoicePrefix: "FESM",
    contactEmail: "facturacion@sonymelona.com",
    invoiceNextNumber: 6483,
    ...over,
  };
}

const ANA = {
  customerName: "Ana Pérez",
  docType: "CC",
  docNumber: "1.020.304.050",
  address: "Calle 1 # 2-3",
  city: "Envigado",
  department: "Antioquia",
  email: "ana@correo.com",
};

function invoice(over: { invoiceRequests?: unknown[]; restaurantId?: string } = {}) {
  return {
    id: "inv-1",
    restaurantId: over.restaurantId ?? "rest-1",
    invoiceNumber: 6482,
    snapshot: {
      restaurantName: "Son y Melona",
      invoicePrefix: "FESM",
      dianResolutionFrom: 1,
      dianResolutionTo: 10000,
    },
    restaurant: { salesTaxKind: "inc", salesTaxPct: 8 },
    order: {
      items: [
        {
          nameSnapshot: "Bandeja paisa",
          qty: 1,
          priceCentsSnapshot: 30_000_00,
          cancelledAt: null as Date | null,
          taxKind: null,
          taxPct: null,
        },
      ],
      invoiceRequests: over.invoiceRequests ?? [],
    },
  };
}

const emit = () => emitDianInvoice({ simpleInvoiceId: "inv-1", restaurantId: "rest-1" });

/** El XML que se firmó (sin firmar: el mock devuelve lo mismo). */
function sentXml(): string {
  return m.signXmlDian.mock.calls[0][0] as string;
}

function customerBlock(xml: string): string {
  return (
    "<cac:AccountingCustomerParty>" +
    xml.split("<cac:AccountingCustomerParty>")[1].split("</cac:AccountingCustomerParty>")[0] +
    "</cac:AccountingCustomerParty>"
  );
}

function tag(xml: string, name: string): string {
  return xml.match(new RegExp(`<${name}[^>]*>([^<]*)</${name}>`))?.[1] ?? "";
}

beforeEach(() => {
  vi.resetAllMocks();
  m.resolveEmisor.mockResolvedValue(emisor());
  m.loadDianConfig.mockResolvedValue({
    configId: "cfg-1",
    environment: "produccion",
    cert: {},
    softwareId: "soft-1",
    softwarePin: "1234",
    technicalKey: "clave-tecnica",
    testSetId: null,
  });
  m.invoiceFindUnique.mockResolvedValue(invoice());
  m.docFindUnique.mockResolvedValue(null);
  m.docCreate.mockResolvedValue({ id: "doc-1" });
  m.docUpdate.mockResolvedValue({ id: "doc-1" });
  m.signXmlDian.mockImplementation((xml: string) => xml);
  m.zipInvoice.mockResolvedValue(Buffer.from("zip"));
  m.sendBillSync.mockResolvedValue({ state: "accepted", errors: [], cufe: "CUFE-DIAN" });
  m.sendDianInvoiceEmail.mockResolvedValue({ ok: true });
});

describe("adquiriente", () => {
  it("sin solicitud sale a consumidor final — el XML no cambia respecto de antes", async () => {
    const r = await emit();
    expect(r.outcome).toBe("accepted");
    const block = customerBlock(sentXml());
    expect(block).toMatchSnapshot();
    expect(block).toContain(">222222222222</cbc:CompanyID>");
    expect(block).toContain("<cbc:AdditionalAccountID>2</cbc:AdditionalAccountID>");
    expect(block).not.toContain("<cac:Contact>");
  });

  it("con solicitud sale a nombre del comensal: cédula, nombre, municipio DANE y correo", async () => {
    m.invoiceFindUnique.mockResolvedValue(invoice({ invoiceRequests: [ANA] }));
    const r = await emit();
    expect(r.outcome).toBe("accepted");
    const block = customerBlock(sentXml());
    expect(block).toMatchSnapshot();
    expect(block).not.toContain("222222222222");
    expect(block).not.toContain("Consumidor final");
    expect(block).toContain(">1020304050</cbc:CompanyID>");
    expect(block).toContain('schemeName="13"');
    expect(block).toContain("<cbc:RegistrationName>Ana Pérez</cbc:RegistrationName>");
    expect(block).toContain("<cbc:ID>05266</cbc:ID><cbc:CityName>Envigado</cbc:CityName>");
    expect(block).toContain("<cbc:Line>Calle 1 # 2-3</cbc:Line>");
    expect(block).toContain("<cbc:ElectronicMail>ana@correo.com</cbc:ElectronicMail>");
    // Persona natural ⇒ PartyIdentification (FAK61) sin DV.
    expect(block).toContain("<cac:PartyIdentification>");
    expect(block).not.toContain("schemeID=");
  });

  it("con NIT va como persona jurídica con el DV en @schemeID", async () => {
    m.invoiceFindUnique.mockResolvedValue(
      invoice({ invoiceRequests: [{ ...ANA, docType: "NIT", docNumber: "901944469-1", customerName: "ACME S.A.S." }] }),
    );
    await emit();
    const block = customerBlock(sentXml());
    expect(block).toContain("<cbc:AdditionalAccountID>1</cbc:AdditionalAccountID>");
    expect(block).toContain('<cbc:CompanyID schemeID="1" schemeName="31"');
    expect(block).toContain(">901944469</cbc:CompanyID>");
    expect(block).not.toContain("<cac:PartyIdentification>");
  });
});

describe("CUFE — NumAdq es el documento del adquiriente que va en el XML", () => {
  async function cufeFromXml(): Promise<{
    declared: string;
    recomputed: string;
    recomputeWith: (customerId: string) => string;
  }> {
    const xml = sentXml();
    const totals = xml
      .split("<cac:LegalMonetaryTotal>")[1]
      .split("</cac:LegalMonetaryTotal>")[0];
    const customerId = tag(customerBlock(xml), "cbc:CompanyID");
    const taxOf = (scheme: "01" | "04") => {
      const group = xml
        .split("<cac:LegalMonetaryTotal>")[0]
        .split("<cac:PaymentMeans>")[1]
        .split("<cac:TaxTotal>")
        .slice(1)
        .map((g) => "<cac:TaxTotal>" + g)
        .find((g) => g.includes(`<cbc:ID>${scheme}</cbc:ID>`));
      return group ? tag(group, "cbc:TaxAmount") : "0.00";
    };
    const recomputeWith = (id: string) =>
      computeCufe({
        invoiceNumber: tag(xml, "cbc:ID"),
        issueDate: tag(xml, "cbc:IssueDate"),
        issueTime: tag(xml, "cbc:IssueTime"),
        lineExtensionAmount: tag(totals, "cbc:LineExtensionAmount"),
        taxIva: taxOf("01"),
        taxInc: taxOf("04"),
        taxIca: "0.00",
        payableAmount: tag(totals, "cbc:PayableAmount"),
        supplierNit: "901944469",
        customerId: id,
        key: "clave-tecnica",
        environment: "1",
      });
    return {
      declared: tag(xml, "cbc:UUID"),
      recomputed: recomputeWith(customerId),
      recomputeWith,
    };
  }

  it("genérica: se calcula con 222222222222", async () => {
    await emit();
    const { declared, recomputed } = await cufeFromXml();
    expect(declared).toBe(recomputed);
    expect(tag(customerBlock(sentXml()), "cbc:CompanyID")).toBe("222222222222");
  });

  it("nominativa: se calcula con la cédula del comensal (y por eso cambia)", async () => {
    m.invoiceFindUnique.mockResolvedValue(invoice({ invoiceRequests: [ANA] }));
    await emit();
    const { declared, recomputed, recomputeWith } = await cufeFromXml();
    expect(tag(customerBlock(sentXml()), "cbc:CompanyID")).toBe("1020304050");
    expect(declared).toBe(recomputed);
    // El mismo documento con el consumidor final como NumAdq daría OTRO
    // CUFE: la DIAN lo verifica contra el adquiriente declarado, así que
    // un XML nominativo con el CUFE del genérico sería un rechazo seguro.
    expect(declared).not.toBe(recomputeWith("222222222222"));
  });
});

describe("resultado y persistencia", () => {
  it("not_found si la factura no existe o es de otro comercio", async () => {
    m.invoiceFindUnique.mockResolvedValue(null);
    expect(await emit()).toEqual({ outcome: "not_found" });
    m.invoiceFindUnique.mockResolvedValue(invoice({ restaurantId: "otro" }));
    expect(await emit()).toEqual({ outcome: "not_found" });
    expect(m.docCreate).not.toHaveBeenCalled();
  });

  it("already_emitted si el documento está aceptado o en vuelo", async () => {
    m.docFindUnique.mockResolvedValue({ id: "doc-1", state: "accepted" });
    expect(await emit()).toEqual({ outcome: "already_emitted" });
    m.docFindUnique.mockResolvedValue({ id: "doc-1", state: "pending" });
    expect(await emit()).toEqual({ outcome: "already_emitted" });
    expect(m.sendBillSync).not.toHaveBeenCalled();
  });

  it("aceptada ⇒ documento actualizado, intento contado, correo al adquiriente", async () => {
    const r = await emit();
    expect(r).toMatchObject({
      outcome: "accepted",
      documentId: "doc-1",
      cufe: "CUFE-DIAN",
      errors: [],
    });
    expect(r.outcome === "accepted" && r.qrUrl).toMatch(/catalogo-vpfe\.dian\.gov\.co/);
    expect(m.docUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "doc-1" },
        data: expect.objectContaining({ state: "accepted", attempts: { increment: 1 } }),
      }),
    );
    expect(m.sendDianInvoiceEmail).toHaveBeenCalledWith({
      documentId: "doc-1",
      environment: "produccion",
    });
  });

  it("error de canal ⇒ outcome error, sin QR y sin correo", async () => {
    m.sendBillSync.mockResolvedValue({ state: "error", errors: ["timeout"] });
    const r = await emit();
    expect(r).toMatchObject({ outcome: "error", errors: ["timeout"], qrUrl: null });
    expect(m.sendDianInvoiceEmail).not.toHaveBeenCalled();
  });
});

describe("guards — bloquean ANTES de firmar y enviar", () => {
  it.each([
    ["resolution_incomplete", emisor({ invoicePrefix: null }), ["invoicePrefix"]],
    ["location_incomplete", emisor({ legalCityCode: null }), ["legalCityCode"]],
    ["contact_email_incomplete", emisor({ contactEmail: null }), ["contactEmail"]],
  ] as const)("%s", async (reason, data, missing) => {
    m.resolveEmisor.mockResolvedValue(data);
    const r = await emit();
    expect(r).toEqual({ outcome: "blocked", reason, missing });
    expect(m.signXmlDian).not.toHaveBeenCalled();
    expect(m.sendBillSync).not.toHaveBeenCalled();
    expect(m.docUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { state: "error", errors: [reason] } }),
    );
  });

  it("sin certificado (DianConfigError) ⇒ blocked con ese código", async () => {
    const { DianConfigError } = await import("./config");
    m.loadDianConfig.mockRejectedValue(new DianConfigError("no_certificate"));
    expect(await emit()).toEqual({ outcome: "blocked", reason: "no_certificate", missing: [] });
    expect(m.sendBillSync).not.toHaveBeenCalled();
  });

  it("sin líneas vivas ⇒ no_lines", async () => {
    const inv = invoice();
    inv.order.items[0].cancelledAt = new Date();
    m.invoiceFindUnique.mockResolvedValue(inv);
    expect(await emit()).toEqual({ outcome: "blocked", reason: "no_lines", missing: [] });
    expect(m.sendBillSync).not.toHaveBeenCalled();
  });
});
