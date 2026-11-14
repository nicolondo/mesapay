import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MANUAL_INVOICE_PAY_LINK_TTL_MS,
  ensureManualInvoicePayLinkInTx,
  manualInvoicePayLinkAvailability,
  manualInvoicePayLinkPath,
  manualInvoicePayLinkStatusPath,
  parsePayLinkRecipients,
  payLinkOnlineMethods,
  payLinkSentTo,
  payLinkState,
  receivablePayLinkExpiry,
  receivablePayLinkState,
} from "./manualInvoicePayLink";

/**
 * Link de pago de la factura manual: gate, estado derivado de la orden y
 * ciclo de vida del token (crear / reutilizar / rotar al vencer).
 */
const NOW = new Date("2026-11-02T12:00:00Z");
const active = {
  kushkiMerchantId: "m1",
  kushkiOnboardingStatus: "active",
  enabledPaymentMethods: ["kushki_card", "kushki_pse", "kushki_apple_pay", "cash"],
};

describe("manualInvoicePayLinkAvailability", () => {
  const base = { tableKind: "manual", orderStatus: "open", outstandingCents: 50_000, tenant: active };

  it("aplica sólo a una factura manual abierta, con saldo y Kushki activo", () => {
    expect(manualInvoicePayLinkAvailability(base)).toEqual({ ok: true });
  });

  it("no existe para una mesa real ni para la de recogida", () => {
    expect(manualInvoicePayLinkAvailability({ ...base, tableKind: "standard" })).toEqual({ ok: false, reason: "not_manual_invoice" });
    expect(manualInvoicePayLinkAvailability({ ...base, tableKind: "pickup" })).toEqual({ ok: false, reason: "not_manual_invoice" });
  });

  it("una cuenta cobrada o descartada no tiene link", () => {
    expect(manualInvoicePayLinkAvailability({ ...base, orderStatus: "paid" })).toEqual({ ok: false, reason: "order_closed" });
    expect(manualInvoicePayLinkAvailability({ ...base, orderStatus: "cancelled" })).toEqual({ ok: false, reason: "order_closed" });
  });

  it("sin saldo no hay nada que cobrar", () => {
    expect(manualInvoicePayLinkAvailability({ ...base, outstandingCents: 0 })).toEqual({ ok: false, reason: "nothing_to_pay" });
  });

  it("exige Kushki activo con algún medio en línea habilitado", () => {
    expect(
      manualInvoicePayLinkAvailability({ ...base, tenant: { ...active, kushkiOnboardingStatus: "submitted" } }),
    ).toEqual({ ok: false, reason: "online_payments_unavailable" });
    expect(manualInvoicePayLinkAvailability({ ...base, tenant: { ...active, kushkiMerchantId: null } })).toEqual({
      ok: false,
      reason: "online_payments_unavailable",
    });
    expect(
      manualInvoicePayLinkAvailability({ ...base, tenant: { ...active, enabledPaymentMethods: ["cash", "external_terminal"] } }),
    ).toEqual({ ok: false, reason: "online_payments_unavailable" });
  });
});

describe("payLinkState", () => {
  const future = new Date(NOW.getTime() + 3600_000);
  const past = new Date(NOW.getTime() - 1);

  it("abierto mientras la orden siga viva y el link no haya vencido", () => {
    expect(payLinkState({ status: "pending", expiresAt: future }, { status: "open" }, NOW.getTime())).toBe("open");
    expect(payLinkState({ status: "pending", expiresAt: null }, { status: "served" }, NOW.getTime())).toBe("open");
  });

  it("la orden manda: pagada en caja → pagado aunque el link haya vencido", () => {
    expect(payLinkState({ status: "pending", expiresAt: past }, { status: "paid" }, NOW.getTime())).toBe("paid");
  });

  it("descartada → anulado; link anulado → anulado", () => {
    expect(payLinkState({ status: "pending", expiresAt: future }, { status: "cancelled" }, NOW.getTime())).toBe("cancelled");
    expect(payLinkState({ status: "cancelled", expiresAt: future }, { status: "open" }, NOW.getTime())).toBe("cancelled");
  });

  it("vencido pasado expiresAt", () => {
    expect(payLinkState({ status: "pending", expiresAt: past }, { status: "open" }, NOW.getTime())).toBe("expired");
    expect(payLinkState({ status: "pending", expiresAt: NOW }, { status: "open" }, NOW.getTime())).toBe("expired");
  });
});

describe("rutas públicas", () => {
  it("nunca llevan el id de la orden y escapan slug y token", () => {
    expect(manualInvoicePayLinkPath("son-y-melona", "abc_DEF-123")).toBe("/r/son-y-melona/cuenta/abc_DEF-123");
    expect(manualInvoicePayLinkStatusPath("x y", "t")).toBe("/r/x%20y/cuenta/t/estado");
  });
});

describe("ensureManualInvoicePayLinkInTx", () => {
  const m = {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  };
  const tx = { paymentLink: m } as unknown as Parameters<typeof ensureManualInvoicePayLinkInTx>[0];
  const args = { restaurantId: "r1", orderId: "o1", amountCents: 120_000, currency: "COP", now: NOW };

  beforeEach(() => {
    vi.clearAllMocks();
    m.create.mockImplementation(async ({ data, select }: { data: Record<string, unknown>; select: unknown }) => {
      void select;
      return { id: "pl1", token: data.token, expiresAt: data.expiresAt, payerEmail: null, emailSentAt: null };
    });
    m.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "pl1",
      token: (data.token as string | undefined) ?? "old-token",
      expiresAt: (data.expiresAt as Date | undefined) ?? new Date(NOW.getTime() + 1000),
      payerEmail: "ana@empresa.com",
      emailSentAt: new Date("2026-11-01T00:00:00Z"),
    }));
  });

  it("crea el link con token aleatorio, kind=order y una semana de vida", async () => {
    m.findUnique.mockResolvedValue(null);
    const link = await ensureManualInvoicePayLinkInTx(tx, args);
    const data = m.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ restaurantId: "r1", orderId: "o1", kind: "order", amountCents: 120_000, currency: "COP" });
    expect(data.token).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(data.token).not.toContain("o1");
    expect(data.expiresAt.getTime()).toBe(NOW.getTime() + MANUAL_INVOICE_PAY_LINK_TTL_MS);
    expect(link.rotated).toBe(true);
    expect(link.token).toBe(data.token);
  });

  it("reutiliza el link vigente (misma URL) y sólo refresca el saldo informativo", async () => {
    m.findUnique.mockResolvedValue({
      id: "pl1", token: "old-token", status: "pending", expiresAt: new Date(NOW.getTime() + 1000), payerEmail: "ana@empresa.com", emailSentAt: null,
    });
    const link = await ensureManualInvoicePayLinkInTx(tx, args);
    expect(m.create).not.toHaveBeenCalled();
    expect(m.update.mock.calls[0][0].data).toEqual({ amountCents: 120_000, currency: "COP" });
    expect(link).toMatchObject({ token: "old-token", rotated: false, payerEmail: "ana@empresa.com" });
  });

  it("vencido: rota el token y le da vida nueva (el viejo deja de servir)", async () => {
    m.findUnique.mockResolvedValue({
      id: "pl1", token: "old-token", status: "pending", expiresAt: new Date(NOW.getTime() - 1), payerEmail: null, emailSentAt: null,
    });
    const link = await ensureManualInvoicePayLinkInTx(tx, args);
    const data = m.update.mock.calls[0][0].data;
    expect(data.token).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(data.token).not.toBe("old-token");
    expect(data.status).toBe("pending");
    expect(data.expiresAt.getTime()).toBe(NOW.getTime() + MANUAL_INVOICE_PAY_LINK_TTL_MS);
    expect(link.rotated).toBe(true);
    expect(link.token).toBe(data.token);
  });

  it("anulado: también rota", async () => {
    m.findUnique.mockResolvedValue({
      id: "pl1", token: "old-token", status: "cancelled", expiresAt: new Date(NOW.getTime() + 1000), payerEmail: null, emailSentAt: null,
    });
    const link = await ensureManualInvoicePayLinkInTx(tx, args);
    expect(link.rotated).toBe(true);
    expect(m.update.mock.calls[0][0].data.token).not.toBe("old-token");
  });
});

describe("ensureManualInvoicePayLinkInTx — factura emitida por cobrar", () => {
  const m = { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() };
  const tx = { paymentLink: m } as unknown as Parameters<typeof ensureManualInvoicePayLinkInTx>[0];
  const due = new Date(NOW.getTime() + 30 * 24 * 3600_000);
  const args = {
    restaurantId: "r1", orderId: "o1", amountCents: 120_000, currency: "COP", now: NOW, creditPaymentId: "pay-credit", expiresAt: due,
  };
  beforeEach(() => {
    vi.clearAllMocks();
    m.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "pl1", ...data, payerEmail: null, emailSentAt: null, emailRecipients: [], openedAt: null }));
    m.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "pl1", token: (data.token as string | undefined) ?? "old-token", expiresAt: (data.expiresAt as Date | undefined) ?? new Date(NOW.getTime() + 1000),
      payerEmail: "ana@empresa.com", emailSentAt: null, emailRecipients: ["ana@empresa.com"], openedAt: new Date(NOW.getTime() - 1000),
    }));
  });

  it("el link que ya tenía el cliente pasa a cobrar el cargo: MISMO token, vida alargada al plazo", async () => {
    m.findUnique.mockResolvedValue({ id: "pl1", token: "old-token", status: "pending", expiresAt: new Date(NOW.getTime() + 1000) });
    const link = await ensureManualInvoicePayLinkInTx(tx, args);
    expect(m.update.mock.calls[0][0].data).toEqual({ amountCents: 120_000, currency: "COP", expiresAt: due, creditPaymentId: "pay-credit" });
    expect(link).toMatchObject({ token: "old-token", rotated: false });
  });

  it("sin link previo lo crea ya ligado al cargo", async () => {
    m.findUnique.mockResolvedValue(null);
    await ensureManualInvoicePayLinkInTx(tx, args);
    expect(m.create.mock.calls[0][0].data).toMatchObject({ creditPaymentId: "pay-credit", expiresAt: due, kind: "order" });
  });

  it("nunca acorta la vida de un link vigente", async () => {
    const later = new Date(due.getTime() + 1000);
    m.findUnique.mockResolvedValue({ id: "pl1", token: "old-token", status: "pending", expiresAt: later });
    await ensureManualInvoicePayLinkInTx(tx, args);
    expect(m.update.mock.calls[0][0].data).not.toHaveProperty("expiresAt");
  });

  it("vencido: token nuevo y nadie lo ha abierto", async () => {
    m.findUnique.mockResolvedValue({ id: "pl1", token: "old-token", status: "pending", expiresAt: new Date(NOW.getTime() - 1) });
    await ensureManualInvoicePayLinkInTx(tx, args);
    const data = m.update.mock.calls[0][0].data;
    expect(data.token).not.toBe("old-token");
    expect(data).toMatchObject({ openedAt: null, creditPaymentId: "pay-credit", expiresAt: due });
  });
});

describe("parsePayLinkRecipients", () => {
  it("junta `emails` y el viejo `email`, en minúsculas y sin repetidos", () => {
    expect(parsePayLinkRecipients({ emails: [" Ana@Empresa.com ", "pagos@empresa.com"], email: "ana@empresa.com" })).toEqual({
      ok: true,
      emails: ["ana@empresa.com", "pagos@empresa.com"],
    });
  });
  it("ignora los vacíos; sin nada no hay correo que mandar", () => {
    expect(parsePayLinkRecipients({ emails: ["", "  "] })).toEqual({ ok: true, emails: [] });
    expect(parsePayLinkRecipients({})).toEqual({ ok: true, emails: [] });
  });
  it("uno inválido invalida el envío; más de 5 también", () => {
    expect(parsePayLinkRecipients({ emails: ["ana@empresa.com", "no-es-correo"] })).toEqual({ ok: false });
    expect(parsePayLinkRecipients({ emails: "ana@empresa.com" })).toEqual({ ok: false });
    expect(parsePayLinkRecipients({ emails: ["a", "b", "c", "d", "e", "f"].map((x) => `${x}@e.co`) })).toEqual({ ok: false });
  });
});

describe("payLinkOnlineMethods", () => {
  const base = { ...active, kushkiBreBPublicKey: null, kushkiBreBPrivateKeyEnc: null };
  const breB = { ...base, kushkiBreBPublicKey: "pub", kushkiBreBPrivateKeyEnc: "enc" };

  it("sólo medios en línea, en orden; nunca efectivo ni datáfono", () => {
    expect(
      payLinkOnlineMethods(
        { ...base, enabledPaymentMethods: ["cash", "external_terminal", "kushki_card_terminal", "kushki_pse", "kushki_card", "kushki_apple_pay"] },
        "COP",
      ),
    ).toEqual(["kushki_card", "kushki_apple_pay", "kushki_pse"]);
  });

  it("null = todo lo de por defecto (sin Bre-B, que nace apagado)", () => {
    expect(payLinkOnlineMethods({ ...breB, enabledPaymentMethods: null }, "COP")).toEqual(["kushki_card", "kushki_apple_pay", "kushki_pse"]);
  });

  it("Bre-B: habilitado, con sus llaves y en pesos; no depende del comercio de tarjeta", () => {
    const enabled = ["kushki_card", "kushki_bre_b"];
    expect(payLinkOnlineMethods({ ...breB, enabledPaymentMethods: enabled }, "COP")).toEqual(["kushki_card", "kushki_bre_b"]);
    expect(payLinkOnlineMethods({ ...base, enabledPaymentMethods: enabled }, "COP")).toEqual(["kushki_card"]);
    expect(payLinkOnlineMethods({ ...breB, enabledPaymentMethods: enabled }, "MXN")).toEqual(["kushki_card"]);
    expect(payLinkOnlineMethods({ ...breB, kushkiOnboardingStatus: "submitted", enabledPaymentMethods: enabled }, "COP")).toEqual(["kushki_bre_b"]);
  });

  it("sin Kushki activo, tarjeta/PSE/Apple Pay no salen", () => {
    expect(payLinkOnlineMethods({ ...base, kushkiMerchantId: null, enabledPaymentMethods: null }, "COP")).toEqual([]);
  });
});

describe("receivablePayLinkState", () => {
  const future = new Date(NOW.getTime() + 3600_000);
  const past = new Date(NOW.getTime() - 1);
  const t = NOW.getTime();
  it("abierto mientras el cargo tenga saldo y el link no venza", () => {
    expect(receivablePayLinkState({ status: "pending", expiresAt: future }, { totalCents: 100, outstandingCents: 100 }, t)).toBe("open");
  });
  it("pagado por el link o con el saldo en cero (pago registrado desde Cartera)", () => {
    expect(receivablePayLinkState({ status: "paid", expiresAt: past }, { totalCents: 100, outstandingCents: 100 }, t)).toBe("paid");
    expect(receivablePayLinkState({ status: "pending", expiresAt: past }, { totalCents: 100, outstandingCents: 0 }, t)).toBe("paid");
  });
  it("anulada con nota crédito (el cargo ya no pesa)", () => {
    expect(receivablePayLinkState({ status: "pending", expiresAt: future }, { totalCents: 0, outstandingCents: 0 }, t)).toBe("cancelled");
  });
  it("vencido con saldo", () => {
    expect(receivablePayLinkState({ status: "pending", expiresAt: past }, { totalCents: 100, outstandingCents: 40 }, t)).toBe("expired");
  });
  it("vida: el plazo del cliente, mínimo una semana", () => {
    expect(receivablePayLinkExpiry(NOW, 30).getTime()).toBe(NOW.getTime() + 30 * 24 * 3600_000);
    expect(receivablePayLinkExpiry(NOW, 0).getTime()).toBe(NOW.getTime() + MANUAL_INVOICE_PAY_LINK_TTL_MS);
  });
  it("destinatarios: la lista nueva, o el correo viejo", () => {
    expect(payLinkSentTo({ payerEmail: "a@e.co", emailRecipients: ["a@e.co", "b@e.co"] })).toEqual(["a@e.co", "b@e.co"]);
    expect(payLinkSentTo({ payerEmail: "a@e.co", emailRecipients: [] })).toEqual(["a@e.co"]);
    expect(payLinkSentTo({ payerEmail: null })).toEqual([]);
  });
});
