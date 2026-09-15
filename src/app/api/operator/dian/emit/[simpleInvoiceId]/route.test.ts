// Guards de la emisión: lo que NO se manda a la DIAN.
//
// Cada rechazo quema un consecutivo del rango autorizado, así que el
// criterio es bloquear antes de enviar cuando ya sabemos que la DIAN va a
// rechazar. Estos tests cubren el guard del correo de recepción de
// documentos electrónicos (FAJ71) y el número que viaja en el XML
// (FAD05a / FAD05b) con los datos reales de Son & Melona.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  erpContext: vi.fn(),
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
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/lib/erp/access", () => ({
  getErpContext: m.erpContext,
  isDenied: (ctx: Record<string, unknown>) => "error" in ctx,
}));
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
// El módulo se mockea PARCIAL a propósito: los guards
// (missingContactFields, missingResolutionFields, missingLocationFields)
// y emisorToSupplierParty corren de verdad — son justamente lo que se
// prueba. Sólo se sustituye lo que tocaría DB/certificados.
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

import { POST } from "./route";
import type { EmisorData } from "@/lib/dian/config";

// Son & Melona: prefijo FESM, resolución 18764094877213, rango 1..10000,
// consecutivo 6482 — el documento que la DIAN rechazó.
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

const snapshot = {
  restaurantName: "Son y Melona",
  invoicePrefix: "FESM",
  dianResolutionFrom: 1,
  dianResolutionTo: 10000,
};

const params = { params: Promise.resolve({ simpleInvoiceId: "inv-1" }) };
const req = () =>
  new Request("http://localhost/api/operator/dian/emit/inv-1", {
    method: "POST",
  });

beforeEach(() => {
  vi.resetAllMocks();
  m.erpContext.mockResolvedValue({ restaurantId: "rest-1", country: "CO" });
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
  m.invoiceFindUnique.mockResolvedValue({
    id: "inv-1",
    restaurantId: "rest-1",
    invoiceNumber: 6482,
    snapshot,
    restaurant: { salesTaxKind: "inc", salesTaxPct: 8 },
    order: {
      items: [
        {
          nameSnapshot: "Bandeja paisa",
          qty: 1,
          priceCentsSnapshot: 30_000_00,
          cancelledAt: null,
          taxKind: null,
          taxPct: null,
        },
      ],
      // Sin solicitud de factura ⇒ consumidor final (el caso de estos tests).
      invoiceRequests: [],
    },
  });
  m.docFindUnique.mockResolvedValue(null);
  m.docCreate.mockResolvedValue({ id: "doc-1", state: "to_send", attempts: 0 });
  // El reclamo (updateMany → sent) lo gana esta emisión.
  m.docUpdateMany.mockResolvedValue({ count: 1 });
  m.docUpdate.mockResolvedValue({ id: "doc-1" });
  m.signXmlDian.mockImplementation((xml: string) => xml);
  m.zipInvoice.mockResolvedValue(Buffer.from("zip"));
  m.sendBillSync.mockResolvedValue({ state: "accepted", errors: [], cufe: "CUFE" });
});

describe("FAJ71 — no se emite sin el correo de recepción de documentos", () => {
  it.each([null, "", "   ", "no-es-un-correo"])(
    "bloquea con contactEmail %j y NO manda nada a la DIAN",
    async (contactEmail) => {
      m.resolveEmisor.mockResolvedValue(emisor({ contactEmail }));
      const res = await POST(req(), params);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "contact_email_incomplete",
        missingContact: ["contactEmail"],
      });
      // Lo importante: el consecutivo no se quema en un rechazo seguro. El
      // documento vuelve a la cola (to_send) con el motivo visible: el
      // barrido lo retoma cuando el operador cargue el correo.
      expect(m.sendBillSync).not.toHaveBeenCalled();
      expect(m.signXmlDian).not.toHaveBeenCalled();
      expect(m.docUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            state: "to_send",
            errors: ["contact_email_incomplete"],
            lastError: "contact_email_incomplete",
          }),
        }),
      );
    },
  );

  it("con el correo cargado sí emite, y va en el cac:Contact del emisor", async () => {
    const res = await POST(req(), params);
    expect(res.status).toBe(200);
    expect(m.sendBillSync).toHaveBeenCalledTimes(1);
    const xml = m.signXmlDian.mock.calls[0][0] as string;
    const supplier = xml
      .split("<cac:AccountingSupplierParty>")[1]
      .split("</cac:AccountingSupplierParty>")[0];
    expect(supplier).toContain(
      "<cac:Contact><cbc:ElectronicMail>facturacion@sonymelona.com</cbc:ElectronicMail></cac:Contact>",
    );
  });
});

describe("FAD05a / FAD05b — el número que viaja en el XML", () => {
  it("manda FESM6482, sin guión ni ceros de relleno", async () => {
    await POST(req(), params);
    const xml = m.signXmlDian.mock.calls[0][0] as string;
    expect(xml).toContain("<cbc:ID>FESM6482</cbc:ID>");
    expect(xml).not.toContain("FESM-06482");
    // Y el zip que se sube lleva el mismo nombre.
    expect(m.zipInvoice).toHaveBeenCalledWith("FESM6482.xml", expect.any(String));
  });

  it("el prefijo declarado y el del número son el mismo string", async () => {
    await POST(req(), params);
    const xml = m.signXmlDian.mock.calls[0][0] as string;
    const declared = xml.match(/<sts:Prefix>([^<]+)<\/sts:Prefix>/)?.[1];
    const id = xml.match(/<cbc:ID>(FESM[^<]*)<\/cbc:ID>/)?.[1] ?? "";
    expect(declared).toBe("FESM");
    // FAD05b: quitándole el prefijo queda un consecutivo del rango 1..10000.
    const consecutivo = Number(id.slice(declared!.length));
    expect(consecutivo).toBe(6482);
    expect(consecutivo).toBeGreaterThanOrEqual(1);
    expect(consecutivo).toBeLessThanOrEqual(10000);
  });
});
