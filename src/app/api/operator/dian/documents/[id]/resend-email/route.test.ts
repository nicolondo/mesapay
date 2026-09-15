// Guardas del reenvío manual: de quién es el documento y en qué estado
// está. El envío en sí (idempotencia, `force`, destinatario) se prueba en
// `src/lib/dian/sendInvoiceEmail.test.ts`; acá se prueba la puerta.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  erpContext: vi.fn(),
  docFindUnique: vi.fn(),
  dianEnvironment: vi.fn(),
  sendDianInvoiceEmail: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/lib/erp/access", () => ({
  getErpContext: m.erpContext,
  isDenied: (ctx: Record<string, unknown>) => "error" in ctx,
}));
vi.mock("@/lib/db", () => ({
  db: { dianDocument: { findUnique: m.docFindUnique } },
}));
vi.mock("@/lib/dian/config", () => ({ dianEnvironment: m.dianEnvironment }));
vi.mock("@/lib/dian/sendInvoiceEmail", () => ({
  sendDianInvoiceEmail: m.sendDianInvoiceEmail,
}));

import { POST } from "./route";

const params = { params: Promise.resolve({ id: "doc-1" }) };
const req = () =>
  new Request("http://localhost/api/operator/dian/documents/doc-1/resend-email", {
    method: "POST",
  });

const call = () => POST(req(), params) as Promise<Response>;

beforeEach(() => {
  vi.resetAllMocks();
  m.erpContext.mockResolvedValue({ restaurantId: "rest-1", country: "CO" });
  m.docFindUnique.mockResolvedValue({
    id: "doc-1",
    restaurantId: "rest-1",
    state: "accepted",
  });
  m.dianEnvironment.mockResolvedValue("produccion");
  m.sendDianInvoiceEmail.mockResolvedValue({
    ok: true,
    to: "comensal@gmail.com",
    emailedAt: "2026-09-14T19:00:00.000Z",
    attachment: true,
  });
});

describe("aislamiento por comercio", () => {
  it("el documento de OTRO comercio responde 404, no 403, y no manda nada", async () => {
    m.docFindUnique.mockResolvedValue({
      id: "doc-1",
      restaurantId: "rest-vecino",
      state: "accepted",
    });
    const res = await call();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(m.sendDianInvoiceEmail).not.toHaveBeenCalled();
  });

  it("un documento que no existe es indistinguible del ajeno", async () => {
    m.docFindUnique.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(404);
    expect(m.sendDianInvoiceEmail).not.toHaveBeenCalled();
  });

  it("sin el módulo einvoicing no se llega ni a mirar el documento", async () => {
    m.erpContext.mockResolvedValue({ error: "module_disabled", status: 403 });
    const res = await call();
    expect(res.status).toBe(403);
    expect(m.docFindUnique).not.toHaveBeenCalled();
    expect(m.sendDianInvoiceEmail).not.toHaveBeenCalled();
  });
});

describe("sólo se reenvía lo que la DIAN aceptó", () => {
  it.each(["to_send", "sent", "pending", "rejected", "error"])(
    "estado %s ⇒ 400 not_accepted",
    async (state) => {
      m.docFindUnique.mockResolvedValue({
        id: "doc-1",
        restaurantId: "rest-1",
        state,
      });
      const res = await call();
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "not_accepted" });
      expect(m.sendDianInvoiceEmail).not.toHaveBeenCalled();
    },
  );

  it("sin configuración DIAN no hay ambiente con el que armar el correo", async () => {
    m.dianEnvironment.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "no_config" });
    expect(m.sendDianInvoiceEmail).not.toHaveBeenCalled();
  });
});

describe("el reenvío", () => {
  it("va con force: sin eso la idempotencia por emailedAt lo bloquearía", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(m.sendDianInvoiceEmail).toHaveBeenCalledWith({
      documentId: "doc-1",
      environment: "produccion",
      force: true,
    });
  });

  it("devuelve a qué correo salió, para poder mostrarlo", async () => {
    const res = await call();
    expect(await res.json()).toEqual({
      sentTo: "comensal@gmail.com",
      emailedAt: "2026-09-14T19:00:00.000Z",
      attachment: true,
    });
  });

  it("el motivo del fallo llega tal cual al cliente", async () => {
    m.sendDianInvoiceEmail.mockResolvedValue({
      ok: false,
      reason: "no_recipient",
    });
    const res = await call();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "no_recipient" });
  });
});
