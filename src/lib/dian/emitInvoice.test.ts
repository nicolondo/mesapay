// La emisión como librería: el adquiriente que viaja en el XML, el CUFE
// que se calcula con ESE mismo adquiriente, los guards que frenan antes
// de gastar un consecutivo, y el reclamo/backoff de la emisión
// automática. Los mocks sustituyen sólo lo que tocaría DB, certificados
// o la red; el builder UBL, el CUFE, los guards y las reglas de reintento
// corren de verdad.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  resolveEmisor: vi.fn(),
  loadDianConfig: vi.fn(),
  invoiceFindUnique: vi.fn(),
  docFindUnique: vi.fn(),
  docCreate: vi.fn(),
  docUpdate: vi.fn(),
  docUpdateMany: vi.fn(),
  signXmlDian: vi.fn(),
  zipInvoice: vi.fn(),
  sendBillSync: vi.fn(),
  sendTestSetAsync: vi.fn(),
  sendDianInvoiceEmail: vi.fn(),
  printAcceptedDianInvoice: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({
  db: {
    simpleInvoice: { findUnique: m.invoiceFindUnique },
    dianDocument: {
      findUnique: m.docFindUnique,
      create: m.docCreate,
      update: m.docUpdate,
      updateMany: m.docUpdateMany,
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
// El hook de impresión de la factura electrónica: se prueba QUE se llama
// (y con qué) al aceptar, y que no se llama en ningún otro desenlace. El
// encolado en sí vive en print/invoiceQueue.test.ts.
vi.mock("@/lib/print/invoiceQueue", () => ({
  printAcceptedDianInvoice: m.printAcceptedDianInvoice,
}));

import { emitDianInvoice, markDocumentBlocked } from "./emitInvoice";
import { computeCufe } from "./crypto";
import { BLOCKED_RETRY_MS, emissionBackoffMs } from "./retry";
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

function invoice(
  over: {
    invoiceRequests?: unknown[];
    restaurantId?: string;
    invoiceNumber?: number;
    /** Campos extra del snapshot (p. ej. la tarifa congelada). */
    snapshot?: Record<string, unknown>;
    restaurant?: { salesTaxKind: string; salesTaxPct: number };
  } = {},
) {
  return {
    id: "inv-1",
    restaurantId: over.restaurantId ?? "rest-1",
    invoiceNumber: over.invoiceNumber ?? 6482,
    snapshot: {
      restaurantName: "Son y Melona",
      invoicePrefix: "FESM",
      dianResolutionFrom: 1,
      dianResolutionTo: 10000,
      ...over.snapshot,
    },
    // La query ya no lo pide; el mock lo devuelve igual para probar que la
    // emisión NO lo mira (ver "impuesto congelado").
    restaurant: over.restaurant ?? { salesTaxKind: "inc", salesTaxPct: 8 },
    order: {
      id: "order-1",
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

const NOW = new Date("2026-09-15T20:00:00.000Z");
const emit = () =>
  emitDianInvoice({ simpleInvoiceId: "inv-1", restaurantId: "rest-1", now: NOW });

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

/** Lo que se escribió en el documento en la última llamada a update. */
function lastUpdateData(): Record<string, unknown> {
  const calls = m.docUpdate.mock.calls;
  return (calls[calls.length - 1][0] as { data: Record<string, unknown> }).data;
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
  // Sin documento previo: se crea en to_send y el reclamo (updateMany →
  // sent) lo gana este emisor.
  m.docFindUnique.mockResolvedValue(null);
  m.docCreate.mockResolvedValue({ id: "doc-1", state: "to_send", attempts: 0 });
  // updateMany sirve para dos cosas: adoptar un placeholder (acá no hay:
  // 0 filas) y RECLAMAR el documento pasándolo a `sent` (lo gana este
  // emisor: 1 fila).
  m.docUpdateMany.mockImplementation(async (args: { data?: { state?: string } }) => ({
    count: args.data?.state === "sent" ? 1 : 0,
  }));
  m.docUpdate.mockResolvedValue({ id: "doc-1" });
  m.signXmlDian.mockImplementation((xml: string) => xml);
  m.zipInvoice.mockResolvedValue(Buffer.from("zip"));
  m.sendBillSync.mockResolvedValue({ state: "accepted", errors: [], cufe: "CUFE-DIAN" });
  m.sendDianInvoiceEmail.mockResolvedValue({ ok: true });
  m.printAcceptedDianInvoice.mockResolvedValue(undefined);
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

  it("sin dirección sale a nombre del comensal SIN cac:PhysicalLocation, como la de consumidor final", async () => {
    m.invoiceFindUnique.mockResolvedValue(
      invoice({ invoiceRequests: [{ ...ANA, address: null, city: null, department: null }] }),
    );
    const r = await emit();
    expect(r.outcome).toBe("accepted");
    const block = customerBlock(sentXml());
    expect(block).toMatchSnapshot();
    expect(block).not.toContain("<cac:PhysicalLocation>");
    expect(block).not.toContain("<cac:Address>");
    expect(block).not.toContain("<cac:RegistrationAddress>");
    // El resto del adquiriente es el mismo que con dirección.
    expect(block).toContain(">1020304050</cbc:CompanyID>");
    expect(block).toContain('schemeName="13"');
    expect(block).toContain("<cbc:RegistrationName>Ana Pérez</cbc:RegistrationName>");
    expect(block).toContain("<cbc:ElectronicMail>ana@correo.com</cbc:ElectronicMail>");
    expect(block).toContain("<cac:PartyIdentification>");
    expect(block).not.toContain("222222222222");
  });

  it("sin dirección: el XML es el de con dirección menos el bloque cac:PhysicalLocation", async () => {
    // Dos emisiones en el mismo test: `sentXml()` lee la primera firma, así
    // que la segunda se toma de la última llamada.
    const lastSignedXml = () => m.signXmlDian.mock.calls.at(-1)?.[0] as string;
    m.invoiceFindUnique.mockResolvedValue(invoice({ invoiceRequests: [ANA] }));
    expect((await emit()).outcome).toBe("accepted");
    const conDireccion = customerBlock(lastSignedXml());
    m.invoiceFindUnique.mockResolvedValue(
      invoice({ invoiceRequests: [{ ...ANA, address: null, city: null, department: null }] }),
    );
    expect((await emit()).outcome).toBe("accepted");
    const sinDireccion = customerBlock(lastSignedXml());
    expect(sinDireccion).not.toBe(conDireccion);
    const sinBloque = conDireccion.replace(
      /<cac:PhysicalLocation>.*?<\/cac:PhysicalLocation>/,
      "",
    );
    expect(sinBloque).not.toBe(conDireccion);
    expect(sinDireccion).toBe(sinBloque);
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

describe("reclamo — nunca dos emisiones del mismo documento", () => {
  it("not_found si la factura no existe o es de otro comercio", async () => {
    m.invoiceFindUnique.mockResolvedValue(null);
    expect(await emit()).toEqual({ outcome: "not_found" });
    m.invoiceFindUnique.mockResolvedValue(invoice({ restaurantId: "otro" }));
    expect(await emit()).toEqual({ outcome: "not_found" });
    expect(m.docCreate).not.toHaveBeenCalled();
  });

  it("el reclamo es un updateMany condicionado por estado que pasa a `sent`", async () => {
    await emit();
    expect(m.docUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "doc-1" }),
        data: { state: "sent" },
      }),
    );
    const claim = m.docUpdateMany.mock.calls
      .map((c) => c[0] as { where: { OR: unknown[] }; data: { state?: string } })
      .find((c) => c.data.state === "sent")!;
    expect(claim.where.OR).toEqual([
      { state: { in: ["to_send", "error", "rejected"] } },
      { state: "sent", updatedAt: { lt: new Date(NOW.getTime() - 15 * 60_000) } },
    ]);
  });

  it("si otro lo reclamó primero (0 filas) ⇒ already_emitted, sin enviar", async () => {
    m.docFindUnique.mockResolvedValue({ id: "doc-1", state: "to_send", attempts: 0 });
    m.docUpdateMany.mockImplementation(async () => ({ count: 0 }));
    expect(await emit()).toEqual({ outcome: "already_emitted" });
    expect(m.sendBillSync).not.toHaveBeenCalled();
    expect(m.signXmlDian).not.toHaveBeenCalled();
    expect(m.docCreate).not.toHaveBeenCalled();
  });

  it("crea el documento en to_send si no existía (con la orden)", async () => {
    await emit();
    expect(m.docCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          restaurantId: "rest-1",
          simpleInvoiceId: "inv-1",
          orderId: "order-1",
          kind: "invoice",
          state: "to_send",
        },
      }),
    );
  });
});

describe("resultado y persistencia", () => {
  it("aceptada ⇒ documento actualizado, intento contado, sin reintento, correo al adquiriente", async () => {
    const r = await emit();
    expect(r).toMatchObject({
      outcome: "accepted",
      documentId: "doc-1",
      cufe: "CUFE-DIAN",
      errors: [],
    });
    expect(r.outcome === "accepted" && r.qrUrl).toMatch(/catalogo-vpfe\.dian\.gov\.co/);
    expect(lastUpdateData()).toMatchObject({
      state: "accepted",
      attempts: { increment: 1 },
      lastError: null,
      nextAttemptAt: null,
    });
    expect(m.sendDianInvoiceEmail).toHaveBeenCalledWith({
      documentId: "doc-1",
      environment: "produccion",
    });
  });

  it("aceptada ⇒ la factura electrónica va al papel UNA vez, con el CUFE y la URL del QR de producción", async () => {
    await emit();
    expect(m.printAcceptedDianInvoice).toHaveBeenCalledTimes(1);
    expect(m.printAcceptedDianInvoice).toHaveBeenCalledWith({
      simpleInvoiceId: "inv-1",
      restaurantId: "rest-1",
      cufe: "CUFE-DIAN",
      qrUrl: "https://catalogo-vpfe.dian.gov.co/document/searchqr?documentkey=CUFE-DIAN",
    });
  });

  it("aceptada en habilitación ⇒ la URL del QR apunta al catálogo -hab", async () => {
    m.loadDianConfig.mockResolvedValue({
      configId: "cfg-1",
      environment: "habilitacion",
      cert: {},
      softwareId: "soft-1",
      softwarePin: "1234",
      technicalKey: "clave-tecnica",
      testSetId: null,
    });
    await emit();
    expect(m.printAcceptedDianInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        qrUrl: "https://catalogo-vpfe-hab.dian.gov.co/document/searchqr?documentkey=CUFE-DIAN",
      }),
    );
  });

  it("aceptada sin CUFE en la respuesta ⇒ el papel lleva el CUFE calculado (el mismo que quedó guardado)", async () => {
    m.sendBillSync.mockResolvedValue({ state: "accepted", errors: [] });
    const r = await emit();
    const saved = lastUpdateData().cufe as string;
    expect(saved).toMatch(/^[0-9a-f]{96}$/);
    expect(r.outcome === "accepted" && r.cufe).toBe(saved);
    expect(m.printAcceptedDianInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ cufe: saved }),
    );
  });

  it("pendiente ⇒ ni correo ni papel: todavía no hay factura electrónica", async () => {
    m.sendBillSync.mockResolvedValue({ state: "pending", errors: [], zipKey: "zip-1" });
    const r = await emit();
    expect(r).toMatchObject({ outcome: "pending", qrUrl: null });
    expect(lastUpdateData()).toMatchObject({ state: "pending", trackId: "zip-1" });
    expect(m.sendDianInvoiceEmail).not.toHaveBeenCalled();
    expect(m.printAcceptedDianInvoice).not.toHaveBeenCalled();
  });

  it("error de canal ⇒ outcome error, backoff exponencial desde los intentos previos, sin correo", async () => {
    m.docFindUnique.mockResolvedValue({ id: "doc-1", state: "error", attempts: 2 });
    m.sendBillSync.mockResolvedValue({ state: "error", errors: ["timeout"] });
    const r = await emit();
    expect(r).toMatchObject({ outcome: "error", errors: ["timeout"], qrUrl: null });
    expect(lastUpdateData()).toMatchObject({
      state: "error",
      lastError: "timeout",
      attempts: { increment: 1 },
      // Tercer intento ⇒ 2 min × 2² = 8 min.
      nextAttemptAt: new Date(NOW.getTime() + emissionBackoffMs(3)),
    });
    expect(m.sendDianInvoiceEmail).not.toHaveBeenCalled();
    expect(m.printAcceptedDianInvoice).not.toHaveBeenCalled();
  });

  it("rechazada ⇒ queda el motivo pero SIN reintento automático", async () => {
    m.sendBillSync.mockResolvedValue({ state: "rejected", errors: ["FAJ71", "FAB10a"] });
    const r = await emit();
    expect(r).toMatchObject({ outcome: "rejected", errors: ["FAJ71", "FAB10a"] });
    expect(lastUpdateData()).toMatchObject({
      state: "rejected",
      lastError: "FAJ71",
      nextAttemptAt: null,
      attempts: { increment: 1 },
    });
    // Rechazada ⇒ nada de papel: una "factura electrónica" sin CUFE
    // aceptado no existe.
    expect(m.sendDianInvoiceEmail).not.toHaveBeenCalled();
    expect(m.printAcceptedDianInvoice).not.toHaveBeenCalled();
  });

  it("si revienta la firma, el documento queda en error con backoff (no reclamado para siempre)", async () => {
    m.signXmlDian.mockImplementation(() => {
      throw new Error("cert vencido");
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await emit();
    expect(r).toMatchObject({ outcome: "error", errors: ["cert vencido"], qrUrl: null });
    expect(lastUpdateData()).toMatchObject({
      state: "error",
      lastError: "cert vencido",
      attempts: { increment: 1 },
      nextAttemptAt: new Date(NOW.getTime() + emissionBackoffMs(1)),
    });
    expect(m.sendBillSync).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  it("la fecha de emisión es la del `now` recibido", async () => {
    await emit();
    expect(tag(sentXml(), "cbc:IssueDate")).toBe("2026-09-15");
  });
});

describe("guards — bloquean ANTES de firmar y enviar, sin consumir nada", () => {
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
    // Vuelve a la cola con el motivo visible y una espera fija; NO cuenta
    // como intento (no se mandó nada) y el consecutivo sigue intacto.
    expect(lastUpdateData()).toEqual({
      state: "to_send",
      errors: [reason],
      lastError: reason,
      nextAttemptAt: new Date(NOW.getTime() + BLOCKED_RETRY_MS),
    });
  });

  it("sin certificado (DianConfigError) ⇒ blocked con ese código", async () => {
    const { DianConfigError } = await import("./config");
    m.loadDianConfig.mockRejectedValue(new DianConfigError("no_certificate"));
    expect(await emit()).toEqual({ outcome: "blocked", reason: "no_certificate", missing: [] });
    expect(m.sendBillSync).not.toHaveBeenCalled();
    expect(lastUpdateData()).toMatchObject({ state: "to_send", lastError: "no_certificate" });
  });

  it("número fuera del rango de la resolución ⇒ number_out_of_range (FAB05b seguro)", async () => {
    m.invoiceFindUnique.mockResolvedValue(invoice({ invoiceNumber: 10001 }));
    expect(await emit()).toEqual({ outcome: "blocked", reason: "number_out_of_range", missing: [] });
    m.invoiceFindUnique.mockResolvedValue(invoice({ invoiceNumber: 0 }));
    expect(await emit()).toEqual({ outcome: "blocked", reason: "number_out_of_range", missing: [] });
    expect(m.sendBillSync).not.toHaveBeenCalled();
  });

  it("el último número del rango sí se emite", async () => {
    m.invoiceFindUnique.mockResolvedValue(invoice({ invoiceNumber: 10000 }));
    expect((await emit()).outcome).toBe("accepted");
    expect(sentXml()).toContain("<cbc:ID>FESM10000</cbc:ID>");
  });

  it("sin líneas vivas ⇒ no_lines", async () => {
    const inv = invoice();
    inv.order.items[0].cancelledAt = new Date();
    m.invoiceFindUnique.mockResolvedValue(inv);
    expect(await emit()).toEqual({ outcome: "blocked", reason: "no_lines", missing: [] });
    expect(m.sendBillSync).not.toHaveBeenCalled();
  });
});

describe("markDocumentBlocked (barrido)", () => {
  it("sólo toca estados reintentables, con el mismo dato que un bloqueo del emit", async () => {
    await markDocumentBlocked("doc-9", "contact_email_incomplete", NOW);
    expect(m.docUpdateMany).toHaveBeenCalledWith({
      where: { id: "doc-9", state: { in: ["to_send", "error", "rejected"] } },
      data: {
        state: "to_send",
        errors: ["contact_email_incomplete"],
        lastError: "contact_email_incomplete",
        nextAttemptAt: new Date(NOW.getTime() + BLOCKED_RETRY_MS),
      },
    });
  });
});

describe("impuesto congelado — el XML lee la tarifa del snapshot, no del comercio", () => {
  /** Totales del documento y el impoconsumo (scheme 04) declarado. */
  function fiscal(xml: string) {
    const totals = xml
      .split("<cac:LegalMonetaryTotal>")[1]
      .split("</cac:LegalMonetaryTotal>")[0];
    const docBlock = xml.split("<cac:PaymentMeans>")[1].split("<cac:LegalMonetaryTotal>")[0];
    const inc = docBlock
      .split("<cac:TaxTotal>")
      .slice(1)
      .map((g) => "<cac:TaxTotal>" + g)
      .find((g) => g.includes("<cbc:ID>04</cbc:ID>"));
    return {
      lineExtension: tag(totals, "cbc:LineExtensionAmount"),
      payable: tag(totals, "cbc:PayableAmount"),
      incAmount: inc ? tag(inc, "cbc:TaxAmount") : null,
    };
  }

  it("comercio en INC 8% pero factura congelada en 'none' ⇒ el XML sale sin impuesto", async () => {
    // Prender el impuesto hoy no puede cambiar lo que declara una tirilla
    // emitida (o reintentada) sin él: el papel dice cero y el XML también.
    m.invoiceFindUnique.mockResolvedValue(
      invoice({
        snapshot: { salesTaxKind: "none", salesTaxPct: 0, embeddedTaxCents: 0, embeddedBaseCents: 30_000_00 },
        restaurant: { salesTaxKind: "inc", salesTaxPct: 8 },
      }),
    );
    expect((await emit()).outcome).toBe("accepted");
    const f = fiscal(sentXml());
    expect(f.lineExtension).toBe("30000.00");
    expect(f.payable).toBe("30000.00");
    expect(f.incAmount).toBeNull();
  });

  it("comercio en 'none' pero factura congelada en INC 8% ⇒ el XML declara el impoconsumo", async () => {
    // Al revés: la tarifa del comercio se apagó después, pero esta factura
    // se emitió con 8% y el papel dice "Incl. impoconsumo 8%: $2.222".
    m.invoiceFindUnique.mockResolvedValue(
      invoice({
        snapshot: { salesTaxKind: "inc", salesTaxPct: 8, embeddedTaxCents: 222_222, embeddedBaseCents: 2_777_778 },
        restaurant: { salesTaxKind: "none", salesTaxPct: 0 },
      }),
    );
    expect((await emit()).outcome).toBe("accepted");
    const f = fiscal(sentXml());
    // Misma cifra que el snapshot, centavo a centavo.
    expect(f.lineExtension).toBe("27777.78");
    expect(f.incAmount).toBe("2222.22");
    expect(f.payable).toBe("30000.00");
  });

  it("snapshot anterior al congelado (sin tarifa) ⇒ sin impuesto, aunque el comercio esté en INC", async () => {
    m.invoiceFindUnique.mockResolvedValue(invoice({ restaurant: { salesTaxKind: "inc", salesTaxPct: 8 } }));
    await emit();
    const f = fiscal(sentXml());
    expect(f.lineExtension).toBe("30000.00");
    expect(f.incAmount).toBeNull();
  });

  it("la query no pide la tarifa del comercio y toma sólo los ítems vivos (sin ronda cancelada)", async () => {
    await emit();
    const args = m.invoiceFindUnique.mock.calls[0][0] as {
      select: { restaurant?: unknown; order: { select: { items: { where: unknown } } } };
    };
    expect(args.select.restaurant).toBeUndefined();
    expect(args.select.order.select.items.where).toEqual({
      cancelledAt: null,
      OR: [{ roundId: null }, { round: { status: { not: "cancelled" } } }],
    });
  });
});

describe("medio de pago (PaymentMeans)", () => {
  it("una cuenta cobrada en efectivo (cash) sale de contado con medio 10 (efectivo)", async () => {
    // La query sólo trae cobros a crédito; una cuenta en efectivo llega sin
    // ninguno, se grabe como cash o como el histórico demo_cash.
    const inv = invoice();
    m.invoiceFindUnique.mockResolvedValue({ ...inv, order: { ...inv.order, payments: [] } });
    expect((await emit()).outcome).toBe("accepted");
    const query = m.invoiceFindUnique.mock.calls[0][0] as {
      select: { order: { select: { payments: { where: Record<string, unknown> } } } };
    };
    expect(query.select.order.select.payments.where).toEqual({ method: "customer_credit", status: "approved" });
    const xml = sentXml();
    expect(tag(xml, "cbc:PaymentMeansCode")).toBe("10");
    expect(xml).toContain("<cac:PaymentMeans><cbc:ID>1</cbc:ID>");
  });
});
