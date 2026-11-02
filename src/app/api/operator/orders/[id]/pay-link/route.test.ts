import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/operator/orders/[id]/pay-link: gate (factura manual abierta con
 * saldo + Kushki activo), creación/reutilización del link, envío por correo
 * y auditoría. Sin DB ni red: todo mockeado.
 */
const m = vi.hoisted(() => ({
  scope: vi.fn(),
  order: vi.fn(),
  linkFindUnique: vi.fn(),
  linkCreate: vi.fn(),
  linkUpdate: vi.fn(),
  sendEmail: vi.fn(),
  audit: vi.fn(),
  sync: vi.fn(),
}));

vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
// `@/lib/staffAccess` (OPERATOR_ROLES) arrastra next-auth; acá no hace falta.
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/operatorScope", () => ({
  requireOperatorScope: m.scope,
  isScopeError: (v: { error?: string }) => "error" in v,
}));
vi.mock("@/lib/auditLog", () => ({ recordAuditEvent: m.audit }));
vi.mock("@/lib/orderTotals", () => ({ syncOrderSubtotalFromLiveItems: m.sync }));
vi.mock("@/lib/billing/countries", () => ({ getCurrencyForCountry: async () => "COP" }));
vi.mock("@/lib/manualInvoicePayLinkEmail", () => ({ sendManualInvoicePayLinkEmail: m.sendEmail }));
vi.mock("@/lib/db", () => {
  const tx = {
    paymentLink: { findUnique: m.linkFindUnique, create: m.linkCreate, update: m.linkUpdate },
  };
  return {
    db: {
      order: { findFirst: m.order },
      $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
  };
});

import { POST } from "./route";

const tenant = {
  name: "Son y Melona",
  slug: "son-y-melona",
  country: "CO",
  kushkiMerchantId: "m1",
  kushkiOnboardingStatus: "active",
  enabledPaymentMethods: ["kushki_card", "kushki_pse", "kushki_apple_pay"],
};
const order = {
  id: "o1",
  status: "open",
  shortCode: "ABC123-DEF456",
  locale: "es",
  subtotalCents: 100_000,
  taxCents: 8_000,
  discountCents: 0,
  table: { kind: "manual" },
  payments: [],
  items: [{ nameSnapshot: "Catering", qty: 1, priceCentsSnapshot: 100_000 }],
  invoiceRequests: [{ customerName: "Empresa S.A.S." }],
  restaurant: tenant,
};
const EXPIRES = new Date("2026-11-09T12:00:00Z");

const post = (body?: unknown) =>
  POST(
    new Request("https://mesapay.co/api/operator/orders/o1/pay-link", {
      method: "POST",
      headers: { "content-type": "application/json", host: "mesapay.co", "x-forwarded-proto": "https" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "o1" }) },
  );

beforeEach(() => {
  vi.clearAllMocks();
  m.scope.mockResolvedValue({ restaurantId: "r1", role: "operator", userId: "u1" });
  m.order.mockResolvedValue(order);
  m.linkFindUnique.mockResolvedValue(null);
  m.linkCreate.mockImplementation(async ({ data }: { data: { token: string } }) => ({
    id: "pl1", token: data.token, expiresAt: EXPIRES, payerEmail: null, emailSentAt: null,
  }));
  m.linkUpdate.mockResolvedValue({ id: "pl1", token: "tok", expiresAt: EXPIRES, payerEmail: "a@b.co", emailSentAt: new Date() });
  m.sendEmail.mockResolvedValue(true);
});

describe("gate", () => {
  it("sólo caja: un mesero no genera links", async () => {
    m.scope.mockResolvedValue({ error: "forbidden" });
    const res = await post({});
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect(m.linkCreate).not.toHaveBeenCalled();
  });

  it("una mesa real no tiene link de pago", async () => {
    m.order.mockResolvedValue({ ...order, table: { kind: "standard" } });
    const res = await post({});
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "not_manual_invoice" });
  });

  it("sin Kushki activo responde con código, no con texto", async () => {
    m.order.mockResolvedValue({ ...order, restaurant: { ...tenant, kushkiOnboardingStatus: "submitted" } });
    const res = await post({});
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "online_payments_unavailable" });
  });

  it("cuenta cobrada o sin saldo", async () => {
    m.order.mockResolvedValue({ ...order, status: "paid" });
    expect(await (await post({})).json()).toEqual({ error: "order_closed" });
    m.order.mockResolvedValue({ ...order, payments: [{ amountCents: 118_800, tipCents: 10_800 }] });
    expect(await (await post({})).json()).toEqual({ error: "nothing_to_pay" });
  });

  it("la orden de otro comercio no existe (el where lleva el restaurante de la sesión)", async () => {
    m.order.mockResolvedValue(null);
    const res = await post({});
    expect(res.status).toBe(404);
    expect(m.order.mock.calls[0][0].where).toEqual({ id: "o1", restaurantId: "r1" });
  });

  it("correo inválido", async () => {
    const res = await post({ email: "no-es-correo" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid" });
  });
});

describe("link", () => {
  it("crea el link con el saldo vivo, arma la URL pública sin el id de la orden y audita", async () => {
    const res = await post({});
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(m.sync).toHaveBeenCalledWith("o1");
    expect(m.linkCreate.mock.calls[0][0].data).toMatchObject({
      restaurantId: "r1", orderId: "o1", kind: "order", amountCents: 108_000, currency: "COP",
    });
    const token = m.linkCreate.mock.calls[0][0].data.token as string;
    expect(j.url).toBe(`https://mesapay.co/r/son-y-melona/cuenta/${token}`);
    // El id de la orden no viaja en la URL: ningún segmento del path es
    // "o1". (Antes se comprobaba con `not.toContain("o1")` sobre la URL
    // entera y el token aleatorio en base64url podía contener «o1» por
    // azar: el test fallaba en main una de cada ~150 corridas.)
    expect(new URL(j.url).pathname.split("/")).not.toContain("o1");
    expect(token).toHaveLength(24);
    expect(j).toMatchObject({ expiresAt: EXPIRES.toISOString(), sentTo: null, sentAt: null, rotated: true });
    expect(m.sendEmail).not.toHaveBeenCalled();
    expect(m.audit).toHaveBeenCalledTimes(1);
    expect(m.audit.mock.calls[0][0]).toMatchObject({ kind: "order.manual_invoice.pay_link.create", target: { type: "order", id: "o1" } });
  });

  it("con correo: manda el link en el idioma de la cuenta, con el detalle, y deja constancia", async () => {
    const res = await post({ email: "pagos@empresa.com" });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(m.sendEmail).toHaveBeenCalledTimes(1);
    expect(m.sendEmail.mock.calls[0][0]).toMatchObject({
      to: "pagos@empresa.com",
      locale: "es",
      restaurantName: "Son y Melona",
      orderCode: "ABC123-DEF456",
      totalCents: 108_000,
      currency: "COP",
      lines: [{ name: "Catering", qty: 1, amountCents: 100_000 }],
      payUrl: j.url,
      expiresAt: EXPIRES,
      customerName: "Empresa S.A.S.",
    });
    expect(m.linkUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "pl1" }, data: expect.objectContaining({ payerEmail: "pagos@empresa.com" }) }),
    );
    expect(j.sentTo).toBe("pagos@empresa.com");
    expect(typeof j.sentAt).toBe("string");
    expect(m.audit.mock.calls.map((c) => c[0].kind)).toEqual([
      "order.manual_invoice.pay_link.create",
      "order.manual_invoice.pay_link.email",
    ]);
  });

  it("si el correo no sale, lo dice (502) pero el link queda creado y se devuelve", async () => {
    m.sendEmail.mockResolvedValue(false);
    const res = await post({ email: "pagos@empresa.com" });
    expect(res.status).toBe(502);
    const j = await res.json();
    expect(j.error).toBe("email_failed");
    expect(j.url).toContain("/r/son-y-melona/cuenta/");
    expect(m.linkUpdate).not.toHaveBeenCalled();
  });

  it("reenviar reutiliza el link vigente (misma URL) sin auditar otra creación", async () => {
    m.linkFindUnique.mockResolvedValue({
      id: "pl1", token: "tok", status: "pending", expiresAt: EXPIRES, payerEmail: "a@b.co", emailSentAt: new Date("2026-11-01T00:00:00Z"),
    });
    const res = await post({});
    const j = await res.json();
    expect(m.linkCreate).not.toHaveBeenCalled();
    expect(j.url).toBe("https://mesapay.co/r/son-y-melona/cuenta/tok");
    expect(j.rotated).toBe(false);
    expect(j.sentTo).toBe("a@b.co");
    expect(m.audit).not.toHaveBeenCalled();
  });
});
