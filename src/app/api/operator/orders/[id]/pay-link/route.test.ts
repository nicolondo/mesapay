import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/operator/orders/[id]/pay-link: gate (factura manual abierta con
 * saldo + algún medio en línea), creación/reutilización del link, envío por
 * correo a VARIOS destinatarios con la factura, "Emitir y enviar factura"
 * (cierra a crédito y el link pasa a cobrar el cargo) y reenvío de la
 * factura por cobrar. Sin DB ni red: todo mockeado.
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
  invoiceFor: vi.fn(),
  issueReceivable: vi.fn(),
  refreshReceivable: vi.fn(),
  issueInvoice: vi.fn(),
  publish: vi.fn(),
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
vi.mock("@/lib/manualInvoicePayLinkInvoice", () => ({ payLinkInvoiceFor: m.invoiceFor }));
vi.mock("@/lib/manualInvoiceReceivable", () => ({
  issueManualInvoiceReceivable: m.issueReceivable,
  refreshReceivablePayLink: m.refreshReceivable,
}));
vi.mock("@/lib/invoiceOnPaid", () => ({ issueInvoiceOnPaid: m.issueInvoice }));
vi.mock("@/lib/events", () => ({ publishOrderEvent: m.publish }));
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
  name: "Restaurante Demo",
  slug: "restaurante-demo",
  country: "CO",
  enabledModules: [],
  kushkiMerchantId: "m1",
  kushkiOnboardingStatus: "active",
  enabledPaymentMethods: ["kushki_card", "kushki_pse", "kushki_apple_pay", "cash", "external_terminal", "kushki_card_terminal"],
  kushkiBreBPublicKey: null,
  kushkiBreBPrivateKeyEnc: null,
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
  invoiceRequests: [{ customerName: "Empresa Demo S.A.S." }],
  payLink: null,
  restaurant: tenant,
};
const EXPIRES = new Date("2026-11-09T12:00:00Z");
const DUE = new Date("2026-12-02T12:00:00Z");
const ON_PAYMENT = { kind: "on_payment", electronic: false };

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
  // Expiry fixtures must not become expired merely because the suite runs later.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-02T12:00:00Z"));
  vi.clearAllMocks();
  m.scope.mockResolvedValue({ restaurantId: "r1", role: "operator", userId: "u1" });
  m.order.mockResolvedValue(order);
  m.linkFindUnique.mockResolvedValue(null);
  m.linkCreate.mockImplementation(async ({ data }: { data: { token: string } }) => ({
    id: "pl1", token: data.token, expiresAt: EXPIRES, payerEmail: null, emailSentAt: null, emailRecipients: [], openedAt: null,
  }));
  m.linkUpdate.mockResolvedValue({
    id: "pl1", token: "tok", expiresAt: EXPIRES, payerEmail: "a@b.co", emailSentAt: new Date(), emailRecipients: ["a@b.co"], openedAt: null,
  });
  m.sendEmail.mockImplementation(async ({ to }: { to: string[] }) => ({ sent: [...to], failed: [] }));
  m.invoiceFor.mockResolvedValue({ invoice: ON_PAYMENT, attachments: [] });
});
afterEach(() => vi.useRealTimers());

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

  it("sólo medios presenciales habilitados (efectivo, datáfono): no hay link", async () => {
    m.order.mockResolvedValue({
      ...order,
      restaurant: { ...tenant, enabledPaymentMethods: ["cash", "external_terminal", "kushki_card_terminal"] },
    });
    expect(await (await post({})).json()).toEqual({ error: "online_payments_unavailable" });
  });

  it("cuenta cobrada o sin saldo", async () => {
    m.order.mockResolvedValue({ ...order, status: "paid" });
    expect(await (await post({})).json()).toEqual({ error: "order_closed" });
    m.order.mockResolvedValue({ ...order, payments: [{ amountCents: 118_800, tipCents: 10_800, method: "cash" }] });
    expect(await (await post({})).json()).toEqual({ error: "nothing_to_pay" });
  });

  it("la orden de otro comercio no existe (el where lleva el restaurante de la sesión)", async () => {
    m.order.mockResolvedValue(null);
    const res = await post({});
    expect(res.status).toBe(404);
    expect(m.order.mock.calls[0][0].where).toEqual({ id: "o1", restaurantId: "r1" });
  });

  it("correo inválido o más de 5 destinatarios", async () => {
    expect(await (await post({ email: "no-es-correo" })).json()).toEqual({ error: "invalid" });
    expect((await post({ emails: ["a@b.co", "malo"] })).status).toBe(400);
    const six = ["a", "b", "c", "d", "e", "f"].map((x) => `${x}@empresa.com`);
    expect((await post({ emails: six })).status).toBe(400);
    expect(m.sendEmail).not.toHaveBeenCalled();
  });
});

describe("link (cuenta abierta)", () => {
  it("crea el link con el saldo vivo, arma la URL pública sin el id de la orden y audita", async () => {
    const res = await post({});
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(m.sync).toHaveBeenCalledWith("o1");
    expect(m.linkCreate.mock.calls[0][0].data).toMatchObject({
      restaurantId: "r1", orderId: "o1", kind: "order", amountCents: 108_000, currency: "COP",
    });
    expect(m.linkCreate.mock.calls[0][0].data).not.toHaveProperty("creditPaymentId");
    const token = m.linkCreate.mock.calls[0][0].data.token as string;
    expect(j.url).toBe(`https://mesapay.co/r/restaurante-demo/cuenta/${token}`);
    // Ningún segmento del path es el id de la orden.
    expect(new URL(j.url).pathname.split("/")).not.toContain("o1");
    expect(token).toHaveLength(24);
    expect(j).toMatchObject({ expiresAt: EXPIRES.toISOString(), sentTo: [], sentAt: null, rotated: true, issued: false, receivable: null });
    expect(m.sendEmail).not.toHaveBeenCalled();
    expect(m.issueReceivable).not.toHaveBeenCalled();
    expect(m.audit).toHaveBeenCalledTimes(1);
    expect(m.audit.mock.calls[0][0]).toMatchObject({ kind: "order.manual_invoice.pay_link.create", target: { type: "order", id: "o1" } });
  });

  it("varios destinatarios: uno por persona, sin repetidos, con los medios EN LÍNEA y la factura; deja constancia de todos", async () => {
    const res = await post({ emails: ["Pagos@Empresa.com", "contabilidad@empresa.com", "pagos@empresa.com", ""] });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(m.sendEmail).toHaveBeenCalledTimes(1);
    const args = m.sendEmail.mock.calls[0][0];
    expect(args).toMatchObject({
      to: ["pagos@empresa.com", "contabilidad@empresa.com"],
      locale: "es",
      restaurantName: "Restaurante Demo",
      orderCode: "ABC123-DEF456",
      totalCents: 108_000,
      currency: "COP",
      lines: [{ name: "Catering", qty: 1, amountCents: 100_000 }],
      payUrl: j.url,
      expiresAt: EXPIRES,
      customerName: "Empresa Demo S.A.S.",
      invoice: ON_PAYMENT,
      dueDate: null,
    });
    // Nunca efectivo ni datáfono: el cliente no está en el local.
    expect(args.methods).toEqual(["kushki_card", "kushki_apple_pay", "kushki_pse"]);
    expect(m.invoiceFor).toHaveBeenCalledWith({ restaurantId: "r1", orderId: "o1", einvoicing: false });
    expect(m.linkUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "pl1" },
        data: expect.objectContaining({
          payerEmail: "pagos@empresa.com",
          emailRecipients: ["pagos@empresa.com", "contabilidad@empresa.com"],
        }),
      }),
    );
    expect(j.sentTo).toEqual(["pagos@empresa.com", "contabilidad@empresa.com"]);
    expect(typeof j.sentAt).toBe("string");
    expect(m.audit.mock.calls.map((c) => c[0].kind)).toEqual([
      "order.manual_invoice.pay_link.create",
      "order.manual_invoice.pay_link.email",
    ]);
  });

  it("el correo viejo (`email`) sigue sirviendo", async () => {
    await post({ email: "pagos@empresa.com" });
    expect(m.sendEmail.mock.calls[0][0].to).toEqual(["pagos@empresa.com"]);
  });

  it("si no sale ningún correo, lo dice (502) pero el link queda creado y se devuelve", async () => {
    m.sendEmail.mockResolvedValue({ sent: [], failed: ["pagos@empresa.com"] });
    const res = await post({ emails: ["pagos@empresa.com"] });
    expect(res.status).toBe(502);
    const j = await res.json();
    expect(j.error).toBe("email_failed");
    expect(j.url).toContain("/r/restaurante-demo/cuenta/");
    expect(m.linkUpdate).not.toHaveBeenCalled();
  });

  it("si sale a algunos, responde 200 con los que fallaron", async () => {
    m.sendEmail.mockResolvedValue({ sent: ["a@empresa.com"], failed: ["b@empresa.com"] });
    const res = await post({ emails: ["a@empresa.com", "b@empresa.com"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sentTo: ["a@empresa.com"], failed: ["b@empresa.com"] });
  });

  it("reenviar reutiliza el link vigente (misma URL) sin auditar otra creación", async () => {
    m.linkFindUnique.mockResolvedValue({ id: "pl1", token: "tok", status: "pending", expiresAt: EXPIRES });
    const res = await post({});
    const j = await res.json();
    expect(m.linkCreate).not.toHaveBeenCalled();
    expect(j.url).toBe("https://mesapay.co/r/restaurante-demo/cuenta/tok");
    expect(j.rotated).toBe(false);
    expect(j.sentTo).toEqual(["a@b.co"]);
    expect(m.audit).not.toHaveBeenCalled();
  });
});

describe("medios ofrecidos según lo habilitado", () => {
  const methodsWith = async (restaurant: Partial<typeof tenant>) => {
    m.order.mockResolvedValue({ ...order, restaurant: { ...tenant, ...restaurant } });
    await post({ emails: ["a@empresa.com"] });
    return m.sendEmail.mock.calls.at(-1)?.[0].methods;
  };

  it("Bre-B sólo con sus llaves cargadas", async () => {
    const enabled = [...tenant.enabledPaymentMethods, "kushki_bre_b"];
    expect(await methodsWith({ enabledPaymentMethods: enabled })).toEqual(["kushki_card", "kushki_apple_pay", "kushki_pse"]);
    expect(
      await methodsWith({ enabledPaymentMethods: enabled, kushkiBreBPublicKey: "pub", kushkiBreBPrivateKeyEnc: "enc" } as never),
    ).toEqual(["kushki_card", "kushki_apple_pay", "kushki_pse", "kushki_bre_b"]);
  });

  it("sólo lo que el comercio habilitó (PSE apagado no sale)", async () => {
    expect(await methodsWith({ enabledPaymentMethods: ["kushki_card", "cash"] })).toEqual(["kushki_card"]);
  });
});

describe("Emitir y enviar factura", () => {
  const issued = {
    ok: true,
    orderId: "o1",
    paymentId: "pay-credit",
    billingCustomerId: "bc1",
    amountCents: 108_000,
    dueDate: DUE,
    link: {
      id: "pl1", token: "tokrec", expiresAt: DUE, payerEmail: null, emailSentAt: null, emailRecipients: [], openedAt: null, rotated: true,
    },
  };
  beforeEach(() => {
    m.issueReceivable.mockResolvedValue(issued);
    m.invoiceFor.mockResolvedValue({
      invoice: { kind: "issued", number: "FE-120", url: "https://mesapay.co/factura/inv1", electronic: null, pendingDian: true },
      attachments: [],
    });
  });

  it("cierra la cuenta a crédito, emite la factura (DIAN en línea), avisa a Mesas y manda la factura con el link", async () => {
    const res = await post({ issue: true, emails: ["pagos@empresa.com", "contabilidad@empresa.com"] });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(m.issueReceivable).toHaveBeenCalledWith(
      expect.objectContaining({ restaurantId: "r1", orderId: "o1", userId: "u1", currency: "COP" }),
    );
    // El comprobante no sale aparte: este correo ya lleva la factura.
    expect(m.issueInvoice).toHaveBeenCalledWith({ tenantId: "r1", orderId: "o1", emit: "inline", deliverEmail: false });
    expect(m.publish).toHaveBeenCalledWith("r1", { type: "order.paid", orderId: "o1" });
    expect(m.sendEmail.mock.calls[0][0]).toMatchObject({
      to: ["pagos@empresa.com", "contabilidad@empresa.com"],
      totalCents: 108_000,
      dueDate: DUE,
      invoice: { kind: "issued", number: "FE-120" },
    });
    // La factura se lee DESPUÉS de emitirla.
    expect(m.issueInvoice.mock.invocationCallOrder[0]).toBeLessThan(m.invoiceFor.mock.invocationCallOrder[0]);
    expect(j).toMatchObject({
      url: "https://mesapay.co/r/restaurante-demo/cuenta/tokrec",
      issued: true,
      receivable: { amountCents: 108_000, dueDate: DUE.toISOString() },
      sentTo: ["pagos@empresa.com", "contabilidad@empresa.com"],
    });
    expect(m.audit.mock.calls.map((c) => c[0].kind)).toEqual([
      "order.manual_invoice.issue_receivable",
      "order.manual_invoice.pay_link.email",
    ]);
  });

  it("sin cliente identificado no emite (código)", async () => {
    m.issueReceivable.mockResolvedValue({ ok: false, error: "customer_required" });
    const res = await post({ issue: true, emails: ["a@empresa.com"] });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "customer_required" });
    expect(m.issueInvoice).not.toHaveBeenCalled();
    expect(m.sendEmail).not.toHaveBeenCalled();
  });

  it("emitida pero el correo no sale: 200 con emailFailed (la factura ya quedó por cobrar)", async () => {
    m.sendEmail.mockResolvedValue({ sent: [], failed: ["a@empresa.com"] });
    const res = await post({ issue: true, emails: ["a@empresa.com"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ issued: true, emailFailed: true, failed: ["a@empresa.com"] });
  });
});

describe("factura ya emitida por cobrar: reenvío", () => {
  const receivableOrder = {
    ...order,
    status: "paid",
    payments: [{ amountCents: 108_000, tipCents: 0, method: "customer_credit" }],
    payLink: {
      id: "pl1",
      restaurantId: "r1",
      token: "tokrec",
      status: "pending",
      expiresAt: new Date("2026-11-01T00:00:00Z"),
      amountCents: 108_000,
      payerEmail: "a@empresa.com",
      emailRecipients: ["a@empresa.com"],
      emailSentAt: new Date("2026-10-20T00:00:00Z"),
      openedAt: null,
      creditPaymentId: "pay-credit",
    },
  };

  it("renueva el link vencido (token nuevo, cobra el saldo vivo del cargo) y lo manda con el vencimiento de la factura", async () => {
    m.order.mockResolvedValue(receivableOrder);
    m.refreshReceivable.mockResolvedValue({
      state: "expired",
      amountCents: 58_000,
      charge: { paymentId: "pay-credit", billingCustomerId: "bc1", totalCents: 108_000, outstandingCents: 58_000, dueDate: DUE },
    });
    m.linkFindUnique.mockResolvedValue({ id: "pl1", token: "tokrec", status: "pending", expiresAt: new Date("2026-11-01T00:00:00Z") });
    const res = await post({ emails: ["a@empresa.com"] });
    expect(res.status).toBe(200);
    const update = m.linkUpdate.mock.calls[0][0];
    expect(update.data).toMatchObject({ status: "pending", amountCents: 58_000, creditPaymentId: "pay-credit", openedAt: null });
    expect(update.data.token).not.toBe("tokrec");
    expect(m.sendEmail.mock.calls[0][0]).toMatchObject({ totalCents: 58_000, dueDate: DUE });
    expect(m.issueReceivable).not.toHaveBeenCalled();
  });

  it("pagada o anulada: no hay nada que reenviar", async () => {
    m.order.mockResolvedValue(receivableOrder);
    m.refreshReceivable.mockResolvedValue({
      state: "paid",
      amountCents: 108_000,
      charge: { paymentId: "pay-credit", billingCustomerId: "bc1", totalCents: 108_000, outstandingCents: 0, dueDate: DUE },
    });
    const res = await post({ emails: ["a@empresa.com"] });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "receivable_closed", state: "paid" });
    expect(m.sendEmail).not.toHaveBeenCalled();
  });
});
