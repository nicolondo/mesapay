// Facturas rechazadas por la DIAN, contra PostgreSQL real: la forma de los
// casos de producción (FAW01 con un postre en $0, regla 90 con CUFE y sin
// trackId, sólo la notificación RUT01, y un rechazo real que NO se toca).
// La DIAN no se llama nunca: getStatus / sendBillSync / GetXmlByDocumentKey
// son mocks; la base, las rutas, el reclamo, el audit y el XML son reales.
import { randomUUID } from "node:crypto";
import JSZip from "jszip";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/lib/db";

const scope = vi.hoisted(() => ({ restaurantId: "", userId: "", role: "operator" }));
const dian = vi.hoisted(() => ({
  sendBillSync: vi.fn(),
  getStatus: vi.fn(),
  getXmlByDocumentKey: vi.fn(),
}));
vi.mock("../src/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("../src/auth", () => ({ auth: async () => ({ user: { id: scope.userId, email: "staff@example.test", role: scope.role } }) }));
vi.mock("../src/lib/activeRestaurant", () => ({ getActiveRestaurantId: async () => scope.restaurantId }));
vi.mock("../src/lib/dian/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/dian/config")>()),
  resolveEmisor: async () => ({
    ref: { kind: "restaurant", id: scope.restaurantId },
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
    invoiceNextNumber: 8000,
  }),
  loadDianConfig: async () => ({
    configId: "cfg-test",
    environment: "produccion",
    cert: {},
    softwareId: "soft-test",
    softwarePin: "0000",
    technicalKey: "clave-tecnica-de-prueba",
    testSetId: null,
  }),
}));
vi.mock("../src/lib/dian/xades", () => ({ signXmlDian: (xml: string) => xml }));
vi.mock("../src/lib/dian/soap", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/dian/soap")>()),
  sendBillSync: dian.sendBillSync,
  getStatus: dian.getStatus,
  getXmlByDocumentKey: dian.getXmlByDocumentKey,
}));
vi.mock("../src/lib/dian/sendInvoiceEmail", () => ({ sendDianInvoiceEmail: vi.fn(async () => ({ ok: false, reason: "no_recipient" })) }));
vi.mock("../src/lib/print/invoiceQueue", () => ({ printAcceptedDianInvoice: vi.fn(async () => undefined) }));

import { POST as recover } from "../src/app/api/operator/dian/documents/[id]/recover/route";
import { GET as batchList, POST as batchRun } from "../src/app/api/admin/restaurants/[id]/dian-recovery/route";
import { invoiceXmlIdentity } from "../src/lib/dian/invoiceXml";

const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["localhost", "127.0.0.1"].includes(database.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname)) {
  throw new Error("Isolated local database required");
}

const FAW01 = "Regla: FAW01, Rechazo: Línea de factura informado con LineExtensionAmount en cero y grupo cac:PricingReference no informado";
const RULE_90 = "Regla: 90, Rechazo: Documento procesado anteriormente.";
const RUT01 = "Regla: RUT01, Notificación: La validación del estado del RUT próximamente estará disponible.";
const FAB10A = "Regla: FAB10a, Rechazo: El prefijo de numeración no es igual al código de la sucursal";
const OLD = "0".repeat(96);
const KEY = "a".repeat(96);
const LAST = "b".repeat(96);

const xmlFor = (number: string, cufe: string) =>
  `<?xml version="1.0"?><Invoice xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="x"><ext:UBLExtensions/><cbc:ID>${number}</cbc:ID><cbc:UUID>${cufe}</cbc:UUID><cbc:IssueDate>2026-10-20</cbc:IssueDate><cbc:IssueTime>13:00:00-05:00</cbc:IssueTime></Invoice>`.replace("<ext:UBLExtensions/>", "<ext:UBLExtensions></ext:UBLExtensions>");
async function zip(xml: string) {
  const z = new JSZip();
  z.file("f.xml", xml);
  return new Uint8Array(await z.generateAsync({ type: "nodebuffer" }));
}
async function unzip(bytes: Uint8Array | null) {
  if (!bytes) return null;
  const z = await JSZip.loadAsync(bytes);
  return Object.values(z.files)[0].async("string");
}
function acceptedStatus(cufe: string, number: string) {
  const ar = `<ApplicationResponse xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"><cac:DocumentResponse><cac:DocumentReference><cbc:ID>${number}</cbc:ID><cbc:UUID>${cufe}</cbc:UUID></cac:DocumentReference></cac:DocumentResponse></ApplicationResponse>`;
  return {
    state: "accepted", statusCode: "00", cufe, errors: [],
    raw: `<Envelope><Body><R><IsValid>true</IsValid><XmlDocumentKey>${cufe}</XmlDocumentKey><XmlBase64Bytes>${Buffer.from(ar).toString("base64")}</XmlBase64Bytes></R></Body></Envelope>`,
  };
}

const tenants: string[] = [];
let tableId: string;

/** Una venta pagada con su tirilla y su documento DIAN como quedó en producción. */
async function invoiceWith(number: number, doc: Record<string, unknown>) {
  const order = await db.order.create({ data: {
    restaurantId: scope.restaurantId, tableId, shortCode: randomUUID(), status: "paid", paidAt: new Date("2026-10-20T18:00:00Z"),
    subtotalCents: 5_400_000, totalCents: 5_400_000,
    items: { create: [
      { nameSnapshot: "Bandeja paisa", priceCentsSnapshot: 4_200_000, qty: 1 },
      { nameSnapshot: "Limonada", priceCentsSnapshot: 1_200_000, qty: 1 },
      { nameSnapshot: "ZPostre Cumpleaños", priceCentsSnapshot: 0, qty: 1 },
    ] },
  } });
  return db.simpleInvoice.create({ data: {
    restaurantId: scope.restaurantId, orderId: order.id, invoiceNumber: number, totalCents: 5_400_000,
    createdAt: new Date("2026-10-20T18:00:00Z"),
    snapshot: { invoicePrefix: "FESM", salesTaxKind: "inc", salesTaxPct: 8, restaurantName: "Prueba", paidAtIso: "2026-10-20T18:00:00.000Z", items: [] },
    dianDocument: { create: { restaurantId: scope.restaurantId, orderId: order.id, kind: "invoice", ...doc } },
  }, include: { dianDocument: true } });
}

const post = (id: string, action: string) =>
  recover(new Request("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) }), { params: Promise.resolve({ id }) });
const adminParams = () => ({ params: Promise.resolve({ id: scope.restaurantId }) });

beforeEach(async () => {
  vi.clearAllMocks();
  dian.getXmlByDocumentKey.mockResolvedValue(null);
  const tenant = await db.restaurant.create({ data: {
    name: "Rechazos DIAN", slug: `dian-rej-${randomUUID()}`, salesTaxKind: "inc", salesTaxPct: 8,
    enabledModules: ["einvoicing"], invoicePrefix: "FESM", invoiceNextNumber: 8000,
  } });
  tenants.push(tenant.id);
  const user = await db.user.create({ data: { restaurantId: tenant.id, role: "operator", email: `${randomUUID()}@example.test`, passwordHash: "test-only" } });
  const table = await db.table.create({ data: { restaurantId: tenant.id, number: 1, qrToken: randomUUID() } });
  scope.restaurantId = tenant.id; scope.userId = user.id; scope.role = "operator";
  tableId = table.id;
});

afterAll(async () => {
  await db.auditEvent.deleteMany({ where: { restaurantId: { in: tenants } } });
  await db.restaurant.deleteMany({ where: { id: { in: tenants } } });
  await db.$disconnect();
});

describe("Reenviar a la DIAN (FAW01)", () => {
  it("mismo número, XML y CUFE nuevos sin la línea en $0, aceptada, sin consumir otro número, y auditado", async () => {
    const inv = await invoiceWith(7913, {
      state: "rejected", attempts: 1, cufe: OLD, lastError: FAW01, errors: [FAW01], xmlZip: await zip(xmlFor("FESM7913", OLD)),
    });
    dian.getStatus.mockResolvedValue({ state: "rejected", statusCode: "99", cufe: OLD, errors: [FAW01] });
    dian.sendBillSync.mockResolvedValue({ state: "accepted", statusCode: "00", errors: [RUT01], raw: "<ok/>" });

    const res = await post(inv.dianDocument!.id, "resend");
    expect(res.status).toBe(200);
    expect((await res.json()).result).toMatchObject({ outcome: "accepted", number: "FESM7913" });

    const doc = await db.dianDocument.findUniqueOrThrow({ where: { id: inv.dianDocument!.id } });
    expect(doc.state).toBe("accepted");
    expect(doc.cufe).not.toBe(OLD);
    expect(doc.warnings).toEqual([RUT01]);
    expect(doc.errors).toEqual([]);
    const xml = (await unzip(doc.xmlZip))!;
    expect(invoiceXmlIdentity(xml)).toEqual({ number: "FESM7913", cufe: doc.cufe });
    expect(xml).not.toContain("ZPostre Cumpleaños");
    expect(xml).toContain("<cbc:LineCountNumeric>2</cbc:LineCountNumeric>");
    // La tirilla y el consecutivo del comercio no se movieron.
    expect((await db.simpleInvoice.findUniqueOrThrow({ where: { id: inv.id } })).invoiceNumber).toBe(7913);
    expect((await db.restaurant.findUniqueOrThrow({ where: { id: scope.restaurantId } })).invoiceNextNumber).toBe(8000);
    const audit = await db.auditEvent.findFirstOrThrow({ where: { restaurantId: scope.restaurantId, kind: "dian.invoice.resend" } });
    expect(audit.targetId).toBe(doc.id);
    expect(audit.diff).toMatchObject({ before: { cufe: OLD, state: "rejected", number: "FESM7913" }, after: { state: "accepted", outcome: "accepted" } });
  });
});

describe("Consultar en la DIAN (regla 90)", () => {
  it("la DIAN la tiene ⇒ aceptada con su CUFE y el XML aceptado; reenviarla no está permitido", async () => {
    const rule90Response = `<Envelope><Body><R><IsValid>false</IsValid><StatusCode>99</StatusCode><XmlDocumentKey>${KEY}</XmlDocumentKey><ErrorMessage><string>${RULE_90}</string></ErrorMessage></R></Body></Envelope>`;
    const inv = await invoiceWith(7920, {
      state: "rejected", attempts: 4, cufe: KEY, trackId: null, lastError: RULE_90, errors: [RULE_90],
      responseXml: rule90Response, xmlZip: await zip(xmlFor("FESM7920", LAST)),
    });
    expect((await post(inv.dianDocument!.id, "resend")).status).toBe(409);
    expect(dian.sendBillSync).not.toHaveBeenCalled();

    dian.getStatus.mockImplementation(async (cufe: string) =>
      cufe === KEY ? acceptedStatus(KEY, "FESM7920") : { state: "rejected", statusCode: "66", errors: [] });
    dian.getXmlByDocumentKey.mockResolvedValue(xmlFor("FESM7920", KEY));
    const res = await post(inv.dianDocument!.id, "check_status");
    expect((await res.json()).result).toMatchObject({ outcome: "accepted" });

    const doc = await db.dianDocument.findUniqueOrThrow({ where: { id: inv.dianDocument!.id } });
    expect(doc).toMatchObject({ state: "accepted", cufe: KEY, lastError: null });
    expect(invoiceXmlIdentity((await unzip(doc.xmlZip))!).cufe).toBe(KEY);
    expect(dian.sendBillSync).not.toHaveBeenCalled();
  });

  it("la DIAN no la confirma ⇒ queda en proceso (pending sin confirmar), nunca rechazada", async () => {
    const inv = await invoiceWith(7921, { state: "rejected", attempts: 3, cufe: KEY, lastError: RULE_90, errors: [RULE_90] });
    dian.getStatus.mockResolvedValue({ state: "rejected", statusCode: "66", errors: [] });
    await post(inv.dianDocument!.id, "check_status");
    const doc = await db.dianDocument.findUniqueOrThrow({ where: { id: inv.dianDocument!.id } });
    expect(doc).toMatchObject({ state: "pending", lastError: "dian_duplicate_unverified", statusNotFoundCount: 1 });
    expect(doc.nextAttemptAt).not.toBeNull();
  });
});

describe("recuperación en lote (admin)", () => {
  it("el listado no toca nada; el lote procesa lo accionable una vez (idempotente) y deja el rechazo real quieto", async () => {
    const faw = await invoiceWith(7930, { state: "rejected", attempts: 1, cufe: OLD, lastError: FAW01, errors: [FAW01] });
    const rut = await invoiceWith(7931, { state: "rejected", attempts: 1, cufe: LAST, lastError: RUT01, errors: [RUT01] });
    const real = await invoiceWith(7932, { state: "rejected", attempts: 1, cufe: KEY, lastError: FAB10A, errors: [FAB10A] });
    scope.role = "platform_admin";

    const listed = await (await batchList(new Request("http://localhost/x"), adminParams())).json();
    expect(listed.items.map((i: { number: string; cause: string; action: string }) => [i.number, i.cause, i.action])).toEqual([
      ["FESM7930", "zero_value_line", "resend"],
      ["FESM7931", "dian_notification", "resend"],
      ["FESM7932", "other", "none"],
    ]);
    expect(dian.getStatus).not.toHaveBeenCalled();
    expect(dian.sendBillSync).not.toHaveBeenCalled();

    dian.getStatus.mockResolvedValue({ state: "rejected", statusCode: "66", errors: [] });
    dian.sendBillSync.mockResolvedValue({ state: "accepted", statusCode: "00", errors: [], raw: "<ok/>" });
    const run = await (await batchRun(
      new Request("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dryRun: false, limit: 25 }) }),
      adminParams(),
    )).json();
    expect(run.results.map((r: { number: string; outcome: string }) => [r.number, r.outcome])).toEqual([
      ["FESM7930", "accepted"],
      ["FESM7931", "accepted"],
    ]);
    expect(run.remaining).toBe(0);
    expect(dian.sendBillSync).toHaveBeenCalledTimes(2);

    const states = await db.dianDocument.findMany({
      where: { id: { in: [faw.dianDocument!.id, rut.dianDocument!.id, real.dianDocument!.id] } },
      select: { id: true, state: true },
    });
    expect(Object.fromEntries(states.map((s) => [s.id, s.state]))).toEqual({
      [faw.dianDocument!.id]: "accepted",
      [rut.dianDocument!.id]: "accepted",
      [real.dianDocument!.id]: "rejected",
    });

    // Segunda corrida: ya no queda nada accionable.
    const again = await (await batchRun(
      new Request("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dryRun: false }) }),
      adminParams(),
    )).json();
    expect(again.results).toEqual([]);
    expect(dian.sendBillSync).toHaveBeenCalledTimes(2);
    expect(await db.auditEvent.count({ where: { restaurantId: scope.restaurantId, kind: "dian.invoice.recovery_batch" } })).toBe(2);
  });

  it("un operador no entra al lote", async () => {
    scope.role = "operator";
    expect((await batchList(new Request("http://localhost/x"), adminParams())).status).toBe(401);
  });
});
