// La emisión frente a las tres causas de rechazo de producción:
//   · regla 90 («Documento procesado anteriormente») ⇒ consulta por CUFE,
//     aceptada si la DIAN la tiene, `pending` sin confirmar si no; NUNCA
//     rechazada;
//   · sólo notificaciones / plantilla de la DIAN sin armar ⇒ `error` con
//     backoff (se reintenta sola), NUNCA rechazada;
//   · reenvío de una rechazada (FAW01) ⇒ mismo número, XML y CUFE nuevos,
//     sin la línea en $0 — y antes, la pregunta por el CUFE anterior.
// Nada llama a la DIAN: getStatus / sendBillSync son mocks.
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
  getStatus: vi.fn(),
  getXmlByDocumentKey: vi.fn(),
  sendDianInvoiceEmail: vi.fn(),
  printAcceptedDianInvoice: vi.fn(),
  closeOnAcceptance: vi.fn(),
  closeDeferred: vi.fn(),
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
vi.mock("@/lib/dian/soap", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dian/soap")>()),
  zipInvoice: m.zipInvoice,
  sendBillSync: m.sendBillSync,
  sendTestSetAsync: m.sendTestSetAsync,
  getStatus: m.getStatus,
  getXmlByDocumentKey: m.getXmlByDocumentKey,
}));
vi.mock("@/lib/dian/sendInvoiceEmail", () => ({ sendDianInvoiceEmail: m.sendDianInvoiceEmail }));
vi.mock("@/lib/print/invoiceQueue", () => ({ printAcceptedDianInvoice: m.printAcceptedDianInvoice }));
vi.mock("@/lib/dian/invoiceRequestClosure", () => ({
  closeInvoiceRequestsOnAcceptance: m.closeOnAcceptance,
  closeInvoiceRequestsAfterDeferredAcceptance: m.closeDeferred,
}));

import { emitDianInvoice } from "./emitInvoice";
import { DUPLICATE_UNVERIFIED, STATUS_CHECK_UNAVAILABLE } from "./invoiceResponse";
import { emissionBackoffMs } from "./retry";
import type { EmisorData } from "./config";

const RULE_90 = "Regla: 90, Rechazo: Documento procesado anteriormente.";
const RUT01_NOTICE = "Regla: RUT01, Notificación: La validación del estado del RUT próximamente estará disponible.";
const RUT01_GLITCH = "Regla: RUT01, Rechazo: Señor usuario en este momento el estado de su RUT es {StatusRut}";
const FAW01 = "Regla: FAW01, Rechazo: Línea de factura informado con LineExtensionAmount en cero y grupo cac:PricingReference no informado";
const DIAN_KEY = "d".repeat(96);
const OLD_CUFE = "e".repeat(96);
const NOW = new Date("2026-11-04T18:00:00.000Z");

function emisor(): EmisorData {
  return {
    ref: { kind: "restaurant", id: "rest-1" },
    legalName: "EMISOR DE PRUEBA S.A.S.",
    taxId: "900373076-5",
    addressLine: "Calle 1 # 2-3",
    cityName: "ENVIGADO",
    legalCityCode: "05266",
    resolution: null,
    resolutionFrom: 1,
    resolutionTo: 10000,
    resolutionNumber: "18760000001",
    resolutionValidFrom: "2025-06-26",
    resolutionValidTo: "2030-06-26",
    resolutionDate: "2025-06-26",
    invoicePrefix: "FESM",
    contactEmail: "facturacion@example.test",
    invoiceNextNumber: 7914,
  };
}

const item = (name: string, price: number) => ({
  id: `it-${name}`,
  nameSnapshot: name,
  qty: 1,
  priceCentsSnapshot: price,
  cancelledAt: null,
  taxKind: null,
  taxPct: null,
});

function invoice() {
  return {
    id: "inv-1",
    restaurantId: "rest-1",
    invoiceNumber: 7913,
    snapshot: {
      restaurantName: "Comercio de prueba",
      invoicePrefix: "FESM",
      salesTaxKind: "inc",
      salesTaxPct: 8,
    },
    order: {
      id: "order-1",
      items: [item("Bandeja paisa", 42_000_00), item("Limonada", 12_000_00), item("ZPostre Cumpleaños", 0)],
      invoiceRequests: [],
      payments: [],
    },
  };
}

const emit = () => emitDianInvoice({ simpleInvoiceId: "inv-1", restaurantId: "rest-1", now: NOW });
const updates = () => m.docUpdate.mock.calls.map((c) => (c[0] as { data: Record<string, unknown> }).data);
const lastUpdate = () => updates().at(-1)!;
const signedXml = () => m.signXmlDian.mock.calls.at(-1)?.[0] as string;
const tag = (xml: string, name: string) => xml.match(new RegExp(`<${name}[^>]*>([^<]*)</${name}>`))?.[1] ?? "";

/** Respuesta de GetStatus de una factura aceptada, con su acuse. */
function acceptedStatus(cufe: string, number = "FESM7913") {
  const ar = `<ApplicationResponse xmlns="urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"><cbc:UUID>${"f".repeat(96)}</cbc:UUID><cac:DocumentResponse><cac:DocumentReference><cbc:ID>${number}</cbc:ID><cbc:UUID>${cufe}</cbc:UUID></cac:DocumentReference></cac:DocumentResponse></ApplicationResponse>`;
  const raw = `<Envelope><Body><GetStatusResponse><GetStatusResult><IsValid>true</IsValid><StatusCode>00</StatusCode><XmlDocumentKey>${cufe}</XmlDocumentKey><XmlBase64Bytes>${Buffer.from(ar).toString("base64")}</XmlBase64Bytes></GetStatusResult></GetStatusResponse></Body></Envelope>`;
  return { state: "accepted" as const, statusCode: "00", cufe, errors: [], raw };
}
const notFound = { state: "rejected" as const, statusCode: "66", errors: [], raw: "<nf/>" };

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
  m.docCreate.mockResolvedValue({ id: "doc-1", state: "to_send", attempts: 0, cufe: null });
  m.docUpdateMany.mockImplementation(async (args: { data?: { state?: string } }) => ({
    count: args.data?.state === "sent" ? 1 : 0,
  }));
  m.docUpdate.mockResolvedValue({ id: "doc-1" });
  m.signXmlDian.mockImplementation((xml: string) => xml);
  m.zipInvoice.mockResolvedValue(Buffer.from("zip-nuevo"));
  m.getXmlByDocumentKey.mockResolvedValue(null);
  m.sendDianInvoiceEmail.mockResolvedValue({ ok: true });
  m.printAcceptedDianInvoice.mockResolvedValue(undefined);
  m.closeOnAcceptance.mockResolvedValue(0);
  m.closeDeferred.mockResolvedValue(0);
});

describe("regla 90 al enviar", () => {
  beforeEach(() => {
    m.sendBillSync.mockResolvedValue({
      state: "rejected",
      statusCode: "99",
      cufe: DIAN_KEY,
      errors: [RULE_90],
      raw: "<regla90/>",
    });
  });

  it("la DIAN la tiene ⇒ ACEPTADA con ese CUFE, correo y papel; nunca se escribe `rejected`", async () => {
    m.getStatus.mockResolvedValue(acceptedStatus(DIAN_KEY));
    const r = await emit();
    expect(r).toMatchObject({ outcome: "accepted", cufe: DIAN_KEY });
    expect(m.getStatus).toHaveBeenCalledWith(DIAN_KEY, expect.anything());
    expect(updates().some((d) => d.state === "rejected")).toBe(false);
    expect(lastUpdate()).toMatchObject({
      state: "accepted",
      cufe: DIAN_KEY,
      errors: [],
      lastError: null,
      attempts: { increment: 1 },
    });
    expect(lastUpdate().responseXml).toContain("IsValid>true");
    expect(m.sendDianInvoiceEmail).toHaveBeenCalledWith({ documentId: "doc-1", environment: "produccion" });
    expect(m.printAcceptedDianInvoice).toHaveBeenCalledWith(expect.objectContaining({ cufe: DIAN_KEY }));
  });

  it("un acuse de OTRO número no cuenta como aceptación", async () => {
    m.getStatus.mockResolvedValue(acceptedStatus(DIAN_KEY, "FESM9999"));
    const r = await emit();
    expect(r.outcome).toBe("pending");
    expect(lastUpdate().state).toBe("pending");
  });

  it("la DIAN no confirma ningún CUFE ⇒ `pending` sin confirmar, con el motivo y la próxima consulta", async () => {
    m.getStatus.mockResolvedValue(notFound);
    const r = await emit();
    expect(r.outcome).toBe("pending");
    expect(lastUpdate()).toMatchObject({
      state: "pending",
      lastError: DUPLICATE_UNVERIFIED,
      cufe: DIAN_KEY,
      errors: [RULE_90],
      responseXml: "<regla90/>",
      statusNotFoundCount: 1,
      attempts: { increment: 1 },
    });
    expect(lastUpdate().nextAttemptAt).toBeInstanceOf(Date);
    expect(m.sendDianInvoiceEmail).not.toHaveBeenCalled();
    expect(m.printAcceptedDianInvoice).not.toHaveBeenCalled();
  });
});

describe("respuestas que no son un rechazo real", () => {
  it("sólo la notificación RUT01 ⇒ `error` con backoff (se reintenta sola), la notificación como advertencia", async () => {
    m.sendBillSync.mockResolvedValue({ state: "rejected", statusCode: "99", errors: [RUT01_NOTICE] });
    const r = await emit();
    expect(r.outcome).toBe("error");
    expect(lastUpdate()).toMatchObject({
      state: "error",
      warnings: [RUT01_NOTICE],
      errors: [RUT01_NOTICE],
      nextAttemptAt: new Date(NOW.getTime() + emissionBackoffMs(1)),
    });
  });

  it("la plantilla sin armar ({StatusRut}) ⇒ `error` con backoff, no `rejected`", async () => {
    m.sendBillSync.mockResolvedValue({ state: "rejected", statusCode: "99", errors: [RUT01_GLITCH] });
    expect((await emit()).outcome).toBe("error");
    expect(lastUpdate().state).toBe("error");
    expect(lastUpdate().nextAttemptAt).toBeInstanceOf(Date);
  });

  it("aceptada con notificaciones ⇒ aceptada; las notificaciones van a `warnings`, no a `errors`", async () => {
    m.sendBillSync.mockResolvedValue({ state: "accepted", statusCode: "00", cufe: DIAN_KEY, errors: [RUT01_NOTICE] });
    expect((await emit()).outcome).toBe("accepted");
    expect(lastUpdate()).toMatchObject({ state: "accepted", warnings: [RUT01_NOTICE] });
  });

  it("un rechazo real sigue siendo `rejected`, sin reintento automático", async () => {
    m.sendBillSync.mockResolvedValue({ state: "rejected", statusCode: "99", errors: [FAW01] });
    expect((await emit()).outcome).toBe("rejected");
    expect(lastUpdate()).toMatchObject({ state: "rejected", nextAttemptAt: null, lastError: FAW01 });
  });
});

describe("reenvío de una factura ya enviada", () => {
  it("rechazada por FAW01: pregunta por el CUFE anterior, no está aceptado ⇒ MISMO número, XML y CUFE nuevos, sin la línea en $0", async () => {
    m.docFindUnique.mockResolvedValue({ id: "doc-1", state: "rejected", attempts: 1, cufe: OLD_CUFE });
    m.getStatus.mockResolvedValue({ state: "rejected", statusCode: "99", cufe: OLD_CUFE, errors: [FAW01] });
    m.sendBillSync.mockResolvedValue({ state: "accepted", statusCode: "00", errors: [] });
    const r = await emit();

    expect(m.getStatus).toHaveBeenCalledWith(OLD_CUFE, expect.anything());
    const xml = signedXml();
    expect(tag(xml, "cbc:ID")).toBe("FESM7913");
    expect(tag(xml, "cbc:UUID")).not.toBe(OLD_CUFE);
    expect(xml).not.toContain("ZPostre Cumpleaños");
    expect(xml).toContain("<cbc:LineCountNumeric>2</cbc:LineCountNumeric>");
    expect(r).toMatchObject({ outcome: "accepted" });
    expect(lastUpdate()).toMatchObject({
      state: "accepted",
      errors: [],
      xmlZip: new Uint8Array(Buffer.from("zip-nuevo")),
      attempts: { increment: 1 },
    });
    expect(lastUpdate().cufe).toBe(tag(xml, "cbc:UUID"));
  });

  it("la DIAN YA tenía el envío anterior ⇒ aceptada con ese CUFE, SIN firmar ni enviar otro", async () => {
    m.docFindUnique.mockResolvedValue({ id: "doc-1", state: "error", attempts: 2, cufe: OLD_CUFE });
    m.getStatus.mockResolvedValue(acceptedStatus(OLD_CUFE));
    const r = await emit();
    expect(r).toMatchObject({ outcome: "accepted", cufe: OLD_CUFE });
    expect(m.signXmlDian).not.toHaveBeenCalled();
    expect(m.sendBillSync).not.toHaveBeenCalled();
    expect(lastUpdate()).toMatchObject({ state: "accepted", cufe: OLD_CUFE, lastError: null });
    expect(m.sendDianInvoiceEmail).toHaveBeenCalledTimes(1);
  });

  it("la consulta del envío anterior no responde ⇒ no se manda uno nuevo (sería la regla 90): error con backoff", async () => {
    m.docFindUnique.mockResolvedValue({ id: "doc-1", state: "error", attempts: 2, cufe: OLD_CUFE });
    m.getStatus.mockResolvedValue({ state: "error", errors: ["timeout"] });
    const r = await emit();
    expect(r.outcome).toBe("error");
    expect(m.sendBillSync).not.toHaveBeenCalled();
    expect(lastUpdate()).toMatchObject({
      state: "error",
      lastError: STATUS_CHECK_UNAVAILABLE,
      attempts: { increment: 1 },
      nextAttemptAt: new Date(NOW.getTime() + emissionBackoffMs(3)),
    });
  });

  it("un documento nuevo (sin CUFE) no consulta nada antes de enviar", async () => {
    m.sendBillSync.mockResolvedValue({ state: "accepted", statusCode: "00", errors: [] });
    await emit();
    expect(m.getStatus).not.toHaveBeenCalled();
  });
});
