import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Puerta de entrada del link de pago de la factura manual: con la cuenta
 * abierta deja la cookie de invitado SÓLO de esa orden y manda al checkout;
 * pagada, a la pantalla de "listo"; anulada/vencida o token ajeno, a la
 * página de estado sin dar acceso a nada.
 */
const m = vi.hoisted(() => ({
  link: vi.fn(),
  grant: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/lib/db", () => ({ db: { paymentLink: { findUnique: m.link } } }));
vi.mock("@/lib/guestAccess", () => ({ grantGuestAccess: m.grant }));
vi.mock("@/lib/manualInvoiceReceivable", () => ({ refreshReceivablePayLink: m.refresh }));

import { GET } from "./route";

const NOW = Date.now();
const openLink = {
  kind: "order",
  status: "pending",
  expiresAt: new Date(NOW + 3600_000),
  restaurant: { id: "r1", slug: "son-y-melona" },
  order: { id: "o1", status: "open", table: { kind: "manual" } },
};
const call = (slug = "son-y-melona", token = "tok") =>
  GET(new Request(`https://mesapay.co/r/${slug}/cuenta/${token}`), { params: Promise.resolve({ slug, token }) });

beforeEach(() => {
  vi.clearAllMocks();
  m.link.mockResolvedValue(openLink);
});

describe("GET /r/[slug]/cuenta/[token]", () => {
  it("cuenta abierta: cookie de invitado de ESA orden y al checkout del comensal", async () => {
    const res = await call();
    expect(m.link).toHaveBeenCalledWith(expect.objectContaining({ where: { token: "tok" } }));
    expect(m.grant).toHaveBeenCalledWith({ restaurantId: "r1", orderId: "o1" });
    expect(m.grant.mock.calls[0][0]).not.toHaveProperty("tableId");
    expect(res.status).toBe(307);
    // `l=1`: la página marca "abierto" desde el navegador.
    expect(res.headers.get("Location")).toBe("/t/son-y-melona/pay/o1?l=1");
  });

  it("factura emitida por cobrar: a la página de monto fijo del MISMO token, sin cookie de la orden", async () => {
    m.link.mockResolvedValue({ ...openLink, creditPaymentId: "pay-credit", order: { ...openLink.order, status: "paid" } });
    m.refresh.mockResolvedValue({ state: "open", amountCents: 108_000, charge: {} });
    const res = await call();
    expect(m.grant).not.toHaveBeenCalled();
    expect(res.headers.get("Location")).toBe("/r/son-y-melona/pago/tok");
    // Pagada: la misma página lo dice.
    m.refresh.mockResolvedValue({ state: "paid", amountCents: 108_000, charge: {} });
    expect((await call()).headers.get("Location")).toBe("/r/son-y-melona/pago/tok");
  });

  it.each(["cancelled", "expired"])("factura por cobrar %s: a la página de estado", async (state) => {
    m.link.mockResolvedValue({ ...openLink, creditPaymentId: "pay-credit", order: { ...openLink.order, status: "paid" } });
    m.refresh.mockResolvedValue({ state, amountCents: 108_000, charge: null });
    const res = await call();
    expect(res.headers.get("Location")).toBe("/r/son-y-melona/cuenta/tok/estado");
  });

  it("cuenta ya pagada: al comprobante (done), con acceso a la orden", async () => {
    m.link.mockResolvedValue({ ...openLink, order: { ...openLink.order, status: "paid" } });
    const res = await call();
    expect(m.grant).toHaveBeenCalledWith({ restaurantId: "r1", orderId: "o1" });
    expect(res.headers.get("Location")).toBe("/t/son-y-melona/pay/o1/done");
  });

  it.each([
    ["anulada", { ...openLink, order: { ...openLink.order, status: "cancelled" } }],
    ["vencido", { ...openLink, expiresAt: new Date(NOW - 1) }],
    ["link anulado", { ...openLink, status: "cancelled" }],
  ])("%s: a la página de estado, sin cookie", async (_label, link) => {
    m.link.mockResolvedValue(link);
    const res = await call();
    expect(m.grant).not.toHaveBeenCalled();
    expect(res.status).toBe(307);
    expect(res.headers.get("Location")).toBe("/r/son-y-melona/cuenta/tok/estado");
  });

  it.each([
    ["token inexistente", null],
    ["link de bonos", { ...openLink, kind: "voucher_batch", order: null }],
    ["otro comercio", { ...openLink, restaurant: { id: "r2", slug: "otro" } }],
    ["mesa real", { ...openLink, order: { ...openLink.order, table: { kind: "standard" } } }],
  ])("%s: no abre nada", async (_label, link) => {
    m.link.mockResolvedValue(link);
    const res = await call();
    expect(m.grant).not.toHaveBeenCalled();
    expect(res.headers.get("Location")).toBe("/r/son-y-melona/cuenta/tok/estado");
  });
});
