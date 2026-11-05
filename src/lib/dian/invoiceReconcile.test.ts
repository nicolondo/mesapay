// «Consultar en la DIAN»: la consulta por CUFE de una factura que la DIAN
// dijo tener (regla 90). Forma real de los 5 casos de producción: estado
// `rejected`, intentos 3–6, `cufe` guardado (= el XmlDocumentKey que
// devolvió la DIAN), `trackId` vacío y el XML guardado del ÚLTIMO intento
// (otro CUFE). Nada llama a la DIAN.
import JSZip from "jszip";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  update: vi.fn(),
  loadDianConfig: vi.fn(),
  getStatus: vi.fn(),
  getXmlByDocumentKey: vi.fn(),
  email: vi.fn(),
  print: vi.fn(),
  closeDeferred: vi.fn(),
  closeOnAcceptance: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({
  db: { dianDocument: { findUnique: m.findUnique, updateMany: m.updateMany, update: m.update } },
}));
vi.mock("@/lib/dian/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dian/config")>()),
  loadDianConfig: m.loadDianConfig,
}));
vi.mock("@/lib/dian/soap", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dian/soap")>()),
  getStatus: m.getStatus,
  getXmlByDocumentKey: m.getXmlByDocumentKey,
}));
vi.mock("@/lib/dian/sendInvoiceEmail", () => ({ sendDianInvoiceEmail: m.email }));
vi.mock("@/lib/print/invoiceQueue", () => ({ printAcceptedDianInvoice: m.print }));
vi.mock("@/lib/dian/invoiceRequestClosure", () => ({
  closeInvoiceRequestsAfterDeferredAcceptance: m.closeDeferred,
  closeInvoiceRequestsOnAcceptance: m.closeOnAcceptance,
}));

import {
  checkDianInvoiceStatus,
  MAX_VERIFY_CHECKS,
  storedCufeCandidates,
  sweepUnverifiedInvoices,
} from "./invoiceReconcile";
import { DUPLICATE_UNVERIFIED } from "./invoiceResponse";
import { invoiceXmlIdentity } from "./invoiceXml";

const RULE_90 = "Regla: 90, Rechazo: Documento procesado anteriormente.";
const FAW01 = "Regla: FAW01, Rechazo: Línea de factura informado con LineExtensionAmount en cero";
const ACCEPTED_CUFE = "a".repeat(96); // el envío que la DIAN aceptó (respuesta perdida)
const LAST_CUFE = "b".repeat(96); // el último intento, el que chocó con la regla 90
const PORTAL_CUFE = "c".repeat(96);
const NOW = new Date("2026-11-04T18:00:00.000Z");

const invoiceXml = (cufe: string, number = "FESM7001") =>
  `<?xml version="1.0"?><Invoice xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="x"><ext:UBLExtensions><ext:UBLExtension/></ext:UBLExtensions><cbc:ID>${number}</cbc:ID><cbc:UUID schemeName="CUFE-SHA384">${cufe}</cbc:UUID><cbc:IssueDate>2026-10-20</cbc:IssueDate><cbc:IssueTime>13:00:00-05:00</cbc:IssueTime></Invoice>`;

async function zipOf(xml: string): Promise<Buffer> {
  const z = new JSZip();
  z.file("FESM7001.xml", xml);
  return z.generateAsync({ type: "nodebuffer" });
}

/** La respuesta de la regla 90 que quedó guardada. */
const rule90Response = `<Envelope><Body><SendBillSyncResponse><SendBillSyncResult><IsValid>false</IsValid><StatusCode>99</StatusCode><XmlDocumentKey>${ACCEPTED_CUFE}</XmlDocumentKey><ErrorMessage><string>${RULE_90}</string></ErrorMessage></SendBillSyncResult></SendBillSyncResponse></Body></Envelope>`;

function acceptedStatus(cufe: string, number = "FESM7001") {
  const ar = `<ApplicationResponse xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"><cbc:UUID>${"f".repeat(96)}</cbc:UUID><cac:DocumentResponse><cac:DocumentReference><cbc:ID>${number}</cbc:ID><cbc:UUID>${cufe}</cbc:UUID></cac:DocumentReference></cac:DocumentResponse></ApplicationResponse>`;
  return {
    state: "accepted" as const,
    statusCode: "00",
    cufe,
    errors: [],
    raw: `<Envelope><Body><GetStatusResult><IsValid>true</IsValid><XmlDocumentKey>${cufe}</XmlDocumentKey><XmlBase64Bytes>${Buffer.from(ar).toString("base64")}</XmlBase64Bytes></GetStatusResult></Body></Envelope>`,
  };
}
const notFound = { state: "rejected" as const, statusCode: "66", errors: [], raw: "<nf/>" };

let storedZip: Buffer;
function rule90Doc(over: Record<string, unknown> = {}) {
  return {
    id: "doc-90",
    restaurantId: "rest-1",
    kind: "invoice",
    state: "rejected",
    cufe: ACCEPTED_CUFE,
    xmlZip: storedZip,
    responseXml: rule90Response,
    lastError: RULE_90,
    errors: [RULE_90],
    updatedAt: new Date("2026-10-20T18:10:00Z"),
    statusNotFoundCount: 0,
    simpleInvoice: {
      id: "inv-90",
      orderId: "order-90",
      invoiceNumber: 7001,
      snapshot: { invoicePrefix: "FESM" },
      createdAt: new Date("2026-10-20T18:00:00Z"),
    },
    ...over,
  };
}
const updates = () => m.update.mock.calls.map((c) => (c[0] as { data: Record<string, unknown> }).data);

beforeEach(async () => {
  vi.resetAllMocks();
  storedZip = await zipOf(invoiceXml(LAST_CUFE));
  m.findUnique.mockResolvedValue(rule90Doc());
  m.updateMany.mockResolvedValue({ count: 1 });
  m.update.mockResolvedValue({});
  m.loadDianConfig.mockResolvedValue({ configId: "cfg", environment: "produccion", cert: {}, softwareId: "s", softwarePin: "p", technicalKey: "k", testSetId: null });
  m.getXmlByDocumentKey.mockResolvedValue(null);
  m.email.mockResolvedValue({ ok: true });
  m.print.mockResolvedValue(undefined);
  m.closeDeferred.mockResolvedValue(0);
});

const check = (over: Partial<Parameters<typeof checkDianInvoiceStatus>[0]> = {}) =>
  checkDianInvoiceStatus({ documentId: "doc-90", restaurantId: "rest-1", now: NOW, ...over });

describe("storedCufeCandidates", () => {
  it("el guardado (= XmlDocumentKey de la regla 90) primero, después el del XML guardado, sin repetir", async () => {
    expect(await storedCufeCandidates(rule90Doc())).toEqual([ACCEPTED_CUFE, LAST_CUFE]);
  });
});

describe("checkDianInvoiceStatus", () => {
  it("la DIAN la tiene ⇒ ACEPTADA, con el XML aceptado traído de la DIAN, correo y SIN papel (es vieja)", async () => {
    m.getStatus.mockResolvedValue(acceptedStatus(ACCEPTED_CUFE));
    m.getXmlByDocumentKey.mockResolvedValue(invoiceXml(ACCEPTED_CUFE));
    const r = await check();

    expect(r).toMatchObject({ outcome: "accepted", cufe: ACCEPTED_CUFE });
    // Cerrojo: reclamada a `sent` sólo si nadie la tocó desde la lectura.
    expect(m.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "doc-90", updatedAt: rule90Doc().updatedAt }),
        data: { state: "sent" },
      }),
    );
    expect(m.getStatus).toHaveBeenCalledTimes(1);
    expect(m.getStatus).toHaveBeenCalledWith(ACCEPTED_CUFE, expect.anything());
    const data = updates().at(-1)!;
    expect(data).toMatchObject({ state: "accepted", cufe: ACCEPTED_CUFE, errors: [], lastError: null, statusNotFoundCount: 0 });
    // El XML guardado era el del último intento (otro CUFE): se reemplaza por el aceptado.
    const xml = (await new JSZip().loadAsync(data.xmlZip as Uint8Array).then((z) => Object.values(z.files)[0].async("string")));
    expect(invoiceXmlIdentity(xml)).toEqual({ number: "FESM7001", cufe: ACCEPTED_CUFE });
    expect(m.email).toHaveBeenCalledWith({ documentId: "doc-90", environment: "produccion" });
    expect(m.print).not.toHaveBeenCalled();
    expect(m.closeDeferred).toHaveBeenCalledTimes(1);
  });

  it("una factura de hace un rato SÍ sale al papel al recuperarse", async () => {
    m.findUnique.mockResolvedValue(
      rule90Doc({ simpleInvoice: { ...rule90Doc().simpleInvoice, createdAt: new Date(NOW.getTime() - 30 * 60_000) } }),
    );
    m.getStatus.mockResolvedValue(acceptedStatus(ACCEPTED_CUFE));
    await check();
    expect(m.print).toHaveBeenCalledWith(expect.objectContaining({ cufe: ACCEPTED_CUFE, simpleInvoiceId: "inv-90" }));
  });

  it("la DIAN no tiene ninguno ⇒ `pending` sin confirmar (no rechazada), con la próxima consulta", async () => {
    m.getStatus.mockResolvedValue(notFound);
    const r = await check();
    expect(r).toMatchObject({ outcome: "unverified", channelError: false });
    expect(m.getStatus).toHaveBeenCalledTimes(2);
    const data = updates().at(-1)!;
    expect(data).toMatchObject({ state: "pending", lastError: DUPLICATE_UNVERIFIED, statusNotFoundCount: 1 });
    expect(data.nextAttemptAt).toBeInstanceOf(Date);
    expect(m.email).not.toHaveBeenCalled();
  });

  it("con el tope de consultas deja de consultar sola (nextAttemptAt null)", async () => {
    m.findUnique.mockResolvedValue(
      rule90Doc({ state: "pending", lastError: DUPLICATE_UNVERIFIED, statusNotFoundCount: MAX_VERIFY_CHECKS - 1 }),
    );
    m.getStatus.mockResolvedValue(notFound);
    await check();
    expect(updates().at(-1)).toMatchObject({ statusNotFoundCount: MAX_VERIFY_CHECKS, nextAttemptAt: null });
  });

  it("sin respuesta de la DIAN ⇒ sin confirmar, sin contar como «no la encontró»", async () => {
    m.getStatus.mockResolvedValue({ state: "error", errors: ["timeout"] });
    const r = await check();
    expect(r).toMatchObject({ outcome: "unverified", channelError: true });
    expect(updates().at(-1)).toMatchObject({ state: "pending", statusNotFoundCount: 0 });
  });

  it("un acuse que nombra OTRO número no la acepta", async () => {
    m.getStatus.mockResolvedValue(acceptedStatus(ACCEPTED_CUFE, "FESM9999"));
    expect((await check()).outcome).toBe("unverified");
  });

  it("el CUFE copiado del portal se prueba primero y sólo vale con un acuse de ESTE número", async () => {
    m.getStatus.mockImplementation(async (cufe: string) => (cufe === PORTAL_CUFE ? acceptedStatus(PORTAL_CUFE) : notFound));
    const r = await check({ extraCufe: PORTAL_CUFE.toUpperCase() });
    expect(m.getStatus.mock.calls[0][0]).toBe(PORTAL_CUFE);
    expect(r).toMatchObject({ outcome: "accepted", cufe: PORTAL_CUFE });
  });

  it("una rechazada por FAW01 NO se consulta acá (se reenvía): not_applicable, sin llamar a la DIAN", async () => {
    m.findUnique.mockResolvedValue(rule90Doc({ errors: [FAW01], lastError: FAW01 }));
    expect(await check()).toEqual({ outcome: "not_applicable", state: "rejected" });
    expect(m.getStatus).not.toHaveBeenCalled();
    expect(m.updateMany).not.toHaveBeenCalled();
  });

  it("idempotente: una aceptada no se toca; otro comercio no la ve; si otro la reclamó, nada", async () => {
    m.findUnique.mockResolvedValue(rule90Doc({ state: "accepted" }));
    expect((await check()).outcome).toBe("not_applicable");
    m.findUnique.mockResolvedValue(rule90Doc({ restaurantId: "otro" }));
    expect((await check()).outcome).toBe("not_found");
    m.findUnique.mockResolvedValue(rule90Doc());
    m.updateMany.mockResolvedValue({ count: 0 });
    expect((await check()).outcome).toBe("not_applicable");
    expect(m.getStatus).not.toHaveBeenCalled();
  });
});

describe("sweepUnverifiedInvoices", () => {
  it("consulta las sin confirmar vencidas y cuenta el resultado", async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: "doc-90", restaurantId: "rest-1" }]);
    const { db } = await import("@/lib/db");
    (db.dianDocument as unknown as { findMany: typeof findMany }).findMany = findMany;
    m.findUnique.mockResolvedValue(rule90Doc({ state: "pending", lastError: DUPLICATE_UNVERIFIED }));
    m.getStatus.mockResolvedValue(acceptedStatus(ACCEPTED_CUFE));
    expect(await sweepUnverifiedInvoices({ now: NOW })).toEqual({ scanned: 1, accepted: 1, unverified: 0, skipped: 0 });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ state: "pending", lastError: DUPLICATE_UNVERIFIED, nextAttemptAt: { lte: NOW } }),
      }),
    );
  });
});
