import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MANUAL_INVOICE_PAY_LINK_TTL_MS,
  ensureManualInvoicePayLinkInTx,
  manualInvoicePayLinkAvailability,
  manualInvoicePayLinkPath,
  manualInvoicePayLinkStatusPath,
  payLinkState,
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
