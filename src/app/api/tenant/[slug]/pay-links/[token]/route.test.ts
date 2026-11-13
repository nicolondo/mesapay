// Cobro público de un link de pago con tarjeta: aislamiento por comercio,
// link cerrado, y que aprobado cierre el link (y el lote de bonos).
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  restaurantFindUnique: vi.fn(),
  linkFindUnique: vi.fn(),
  linkUpdateMany: vi.fn(),
  batchUpdateMany: vi.fn(),
  txCreate: vi.fn(),
  charge: vi.fn(),
  privateKey: vi.fn(),
  mode: vi.fn(),
  capture: vi.fn(),
  captureUpdate: vi.fn(),
}));

const tx = {
  paymentLink: { findUnique: m.linkFindUnique, updateMany: m.linkUpdateMany },
  voucherBatch: { updateMany: m.batchUpdateMany },
};

vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/lib/db", () => ({
  db: {
    $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    restaurant: { findUnique: m.restaurantFindUnique },
    paymentLink: { findUnique: m.linkFindUnique, updateMany: m.captureUpdate },
    kushkiTransaction: { create: m.txCreate },
  },
}));
vi.mock("@/lib/payments", () => ({
  getPaymentProvider: async () => ({ chargeWithToken: m.charge }),
  getRestaurantPrivateKey: m.privateKey,
}));
vi.mock("@/lib/platformConfig", () => ({ getRestaurantKushkiMode: m.mode }));
vi.mock("@/lib/walletTrackingCapture", () => ({ captureLinkTrackingFields: m.capture }));

import { POST } from "./route";

/** Misma forma que `KushkiHttpError` (status + body), sin cargar el cliente real. */
const kushkiError = (status: number, body: unknown) =>
  Object.assign(new Error(`kushki ${status}`), {
    name: "KushkiHttpError",
    status,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const link = {
  id: "link-1",
  restaurantId: "rest-1",
  token: "tok-1",
  kind: "voucher_batch",
  status: "pending",
  amountCents: 9_000_000_00,
  currency: "COP",
  voucherBatchId: "batch-1",
  providerRef: null,
  method: null,
  payerEmail: null,
  expiresAt: null,
};

const call = (slug = "son-y-melona", body: unknown = { token: "card-tok", method: "kushki_card" }) =>
  POST(
    new Request(`http://localhost/api/tenant/${slug}/pay-links/tok-1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ slug, token: "tok-1" }) },
  ) as Promise<Response>;

beforeEach(() => {
  vi.resetAllMocks();
  m.restaurantFindUnique.mockResolvedValue({ id: "rest-1", kushkiMerchantId: "m-1", kushkiMode: "mock" });
  m.linkFindUnique.mockResolvedValue(link);
  m.linkUpdateMany.mockResolvedValue({ count: 1 });
  m.batchUpdateMany.mockResolvedValue({ count: 1 });
  m.txCreate.mockResolvedValue({});
  m.privateKey.mockResolvedValue("pk");
  m.mode.mockResolvedValue("mock");
  m.capture.mockResolvedValue({});
  m.charge.mockResolvedValue({ providerRef: "tx-1", status: "approved", raw: {} });
});

describe("aislamiento", () => {
  it("el link de OTRO comercio es un 404 y no se cobra nada", async () => {
    m.restaurantFindUnique.mockResolvedValue({ id: "rest-2", kushkiMerchantId: "m-2", kushkiMode: "mock" });
    const res = await call("otro");
    expect(res.status).toBe(404);
    expect(m.charge).not.toHaveBeenCalled();
    expect(m.linkUpdateMany).not.toHaveBeenCalled();
  });
  it("comercio desconocido: 404", async () => {
    m.restaurantFindUnique.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
  });
  it("comercio sin Kushki: 409", async () => {
    m.restaurantFindUnique.mockResolvedValue({ id: "rest-1", kushkiMerchantId: null, kushkiMode: null });
    expect((await call()).status).toBe(409);
    expect(m.charge).not.toHaveBeenCalled();
  });
});

describe("estado del link", () => {
  it("pagado o cancelado: 409 link_closed, sin cobrar", async () => {
    m.linkFindUnique.mockResolvedValue({ ...link, status: "paid" });
    const res = await call();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "link_closed", status: "paid" });
    expect(m.charge).not.toHaveBeenCalled();
  });
  it("vencido: también cerrado", async () => {
    m.linkFindUnique.mockResolvedValue({ ...link, expiresAt: new Date(Date.now() - 1000) });
    expect((await call()).status).toBe(409);
  });
});

describe("cobro", () => {
  it("freezes the effective collection account before charging and retains it if the response is lost", async () => {
    m.mode.mockResolvedValue("production");
    const binding = { walletTrackingKey: "opaque-binding", walletTrackingMode: "production" };
    m.capture.mockResolvedValue(binding);
    m.charge.mockImplementation(async () => {
      expect(m.captureUpdate).toHaveBeenCalledWith({ where: { id: "link-1", status: "pending" }, data: binding });
      throw new Error("response lost");
    });
    expect((await call()).status).toBe(502);
    expect(m.capture).toHaveBeenCalledWith({ restaurantId: "rest-1", mode: "production", currency: "COP", privateKey: "pk" });
    expect(m.captureUpdate).toHaveBeenCalledTimes(1);
    expect(m.linkUpdateMany).not.toHaveBeenCalled();
  });
  it("aprobado: cobra el monto del link y lo cierra con el lote", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ approved: true, settled: "paid" });
    expect(m.charge).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: { amountCents: 9_000_000_00, currency: "COP" },
        token: "card-tok",
        metadata: { kind: "payment_link", paymentLinkId: "link-1" },
      }),
    );
    expect(m.linkUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "link-1", status: "pending" },
        data: expect.objectContaining({ status: "paid", providerRef: "tx-1", method: "kushki_card" }),
      }),
    );
    expect(m.batchUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "batch-1", status: "issued" } }),
    );
  });
  it("rechazado: responde approved=false con un código, el link sigue pendiente", async () => {
    m.charge.mockResolvedValue({ providerRef: "tx-2", status: "declined", raw: {} });
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ approved: false, reason: "declined" });
    expect(m.linkUpdateMany).not.toHaveBeenCalled();
  });
  it("Kushki rechaza con un 4xx: 502 con motivo traducible, nunca texto fijo", async () => {
    // Lo que de verdad lanza el proveedor: KushkiHttpError con status y body.
    m.charge.mockRejectedValue(kushkiError(402, { code: "021", message: "Fondos insuficientes" }));
    const res = await call();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "charge_failed", reason: "card_funds" });
    expect(m.linkUpdateMany).not.toHaveBeenCalled();
  });
  it("K322 (antifraude de Kushki): motivo security_rejected", async () => {
    m.charge.mockRejectedValue(kushkiError(400, { code: "K322", message: "Transacción rechazada." }));
    const res = await call();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "charge_failed", reason: "security_rejected" });
  });
  it.each([
    ["5xx", () => kushkiError(503, "Service Unavailable")],
    ["timeout", () => Object.assign(new Error("aborted"), { name: "TimeoutError" })],
    ["red caída", () => new TypeError("fetch failed")],
    ["token ya usado (577)", () => kushkiError(400, { code: "577", message: "Token de la transacción no válido" })],
  ])("resultado incierto (%s): no dice «falló», pide revisar antes de repetir", async (_label, make) => {
    m.charge.mockRejectedValue(make());
    const res = await call();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "charge_uncertain", reason: "uncertain" });
    expect(m.linkUpdateMany).not.toHaveBeenCalled();
  });
  it("payload inválido: 400", async () => {
    expect((await call("son-y-melona", { nope: 1 })).status).toBe(400);
    expect(m.charge).not.toHaveBeenCalled();
  });
});
