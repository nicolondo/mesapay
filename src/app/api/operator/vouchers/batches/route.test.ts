// La puerta de la emisión: módulo `vouchers` + rol, y que la empresa sea
// del comercio. La emisión en sí se prueba en src/lib/vouchers/issue.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  erpContext: vi.fn(),
  issue: vi.fn(),
  email: vi.fn(),
  findMany: vi.fn(),
  cancelBatch: vi.fn(),
  cancelVoucher: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("next-intl/server", () => ({ getLocale: async () => "es" }));
vi.mock("@/lib/erp/access", () => ({
  getErpContext: m.erpContext,
  isDenied: (ctx: Record<string, unknown>) => "error" in ctx,
}));
vi.mock("@/lib/db", () => ({ db: { voucherBatch: { findMany: m.findMany } } }));
vi.mock("@/lib/vouchers/issue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/vouchers/issue")>();
  return {
    issueBatchSchema: actual.issueBatchSchema,
    issueVoucherBatch: m.issue,
    emailVoucherBatch: m.email,
    cancelVoucherBatch: m.cancelBatch,
    cancelVoucher: m.cancelVoucher,
  };
});

import { GET, POST } from "./route";
import { POST as CANCEL_BATCH } from "./[id]/cancel/route";
import { POST as CANCEL_VOUCHER } from "../[id]/cancel/route";

const body = { billingCustomerId: "cust-1", quantity: 30, unitValueCents: 300_000_00, expiryDays: 90, note: null };
const req = (payload: unknown = body) =>
  new Request("http://localhost/api/operator/vouchers/batches", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
const post = (payload?: unknown) => POST(req(payload)) as Promise<Response>;
const params = { params: Promise.resolve({ id: "x-1" }) };

beforeEach(() => {
  vi.resetAllMocks();
  m.erpContext.mockResolvedValue({ restaurantId: "rest-1", country: "CO", userId: "user-1" });
  m.issue.mockResolvedValue({
    ok: true,
    batch: { id: "batch-1", mode: "prepaid", quantity: 30, unitValueCents: 300_000_00, totalCents: 9_000_000_00, paymentLinkToken: "tok" },
  });
  m.email.mockResolvedValue(true);
  m.findMany.mockResolvedValue([]);
  m.cancelBatch.mockResolvedValue("ok");
  m.cancelVoucher.mockResolvedValue("ok");
});

describe("gate de módulo", () => {
  it("sin el módulo `vouchers` nada responde ni escribe", async () => {
    m.erpContext.mockResolvedValue({ error: "module_disabled", status: 403 });
    expect((await post()).status).toBe(403);
    expect((await (GET(new Request("http://localhost/api/operator/vouchers/batches")) as Promise<Response>)).status).toBe(403);
    expect((await (CANCEL_BATCH(req(), params) as Promise<Response>)).status).toBe(403);
    expect((await (CANCEL_VOUCHER(req(), params) as Promise<Response>)).status).toBe(403);
    expect(m.issue).not.toHaveBeenCalled();
    expect(m.findMany).not.toHaveBeenCalled();
    expect(m.cancelBatch).not.toHaveBeenCalled();
    expect(m.cancelVoucher).not.toHaveBeenCalled();
  });
  it("sin rol de operador, 401", async () => {
    m.erpContext.mockResolvedValue({ error: "unauthorized", status: 401 });
    expect((await post()).status).toBe(401);
  });
});

describe("emisión", () => {
  it("emite con el restaurante de la SESIÓN (nunca del body) y manda el correo", async () => {
    const res = await post({ ...body, restaurantId: "rest-ajeno" });
    expect(res.status).toBe(201);
    expect(m.issue).toHaveBeenCalledWith({
      restaurantId: "rest-1",
      userId: "user-1",
      input: expect.objectContaining({ billingCustomerId: "cust-1", quantity: 30 }),
    });
    expect(m.email).toHaveBeenCalledWith(
      expect.objectContaining({ restaurantId: "rest-1", batchId: "batch-1", locale: "es" }),
    );
    expect(await res.json()).toMatchObject({ batch: { id: "batch-1" }, emailed: true });
  });
  it("la empresa de otro comercio es un 404", async () => {
    m.issue.mockResolvedValue({ ok: false, error: "customer_not_found" });
    const res = await post();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "customer_not_found" });
    expect(m.email).not.toHaveBeenCalled();
  });
  it("valida antes de emitir: cantidad 0, valor en cero o payload roto", async () => {
    expect((await post({ ...body, quantity: 0 })).status).toBe(400);
    expect((await post({ ...body, unitValueCents: 0 })).status).toBe(400);
    expect((await post("no-json")).status).toBe(400);
    expect(m.issue).not.toHaveBeenCalled();
  });
  it("el correo que falla no frena la emisión: 201 con emailed=false", async () => {
    m.email.mockResolvedValue(false);
    const res = await post();
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ emailed: false });
  });
});

describe("cancelaciones", () => {
  it("el lote/bono de otro comercio responde 404 (el scope es el de la sesión)", async () => {
    m.cancelBatch.mockResolvedValue("not_found");
    m.cancelVoucher.mockResolvedValue("not_found");
    expect((await (CANCEL_BATCH(req(), params) as Promise<Response>)).status).toBe(404);
    expect((await (CANCEL_VOUCHER(req(), params) as Promise<Response>)).status).toBe(404);
    expect(m.cancelBatch).toHaveBeenCalledWith({ restaurantId: "rest-1", batchId: "x-1" });
    expect(m.cancelVoucher).toHaveBeenCalledWith({ restaurantId: "rest-1", voucherId: "x-1" });
  });
  it("con uso o ya pagado, 409 con el motivo", async () => {
    m.cancelBatch.mockResolvedValue("used");
    const r1 = await (CANCEL_BATCH(req(), params) as Promise<Response>);
    expect(r1.status).toBe(409);
    expect(await r1.json()).toEqual({ error: "used" });
    m.cancelBatch.mockResolvedValue("paid");
    expect((await (CANCEL_BATCH(req(), params) as Promise<Response>)).status).toBe(409);
  });
});

describe("listado", () => {
  it("lista sólo lotes del comercio activo", async () => {
    expect((await (GET(new Request("http://localhost/api/operator/vouchers/batches")) as Promise<Response>)).status).toBe(200);
    expect(m.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { restaurantId: "rest-1" } }),
    );
  });
});
