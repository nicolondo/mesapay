import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  sendSimpleInvoiceEmail: vi.fn(async () => true),
  sendDianInvoiceEmail: vi.fn(async () => ({ ok: true })),
  dianEnvironment: vi.fn(async () => "produccion" as const),
  dianDocumentFindUnique: vi.fn(),
}));

vi.mock("@/lib/simpleInvoice", () => ({ sendSimpleInvoiceEmail: m.sendSimpleInvoiceEmail }));
vi.mock("@/lib/dian/sendInvoiceEmail", () => ({ sendDianInvoiceEmail: m.sendDianInvoiceEmail }));
vi.mock("@/lib/dian/config", () => ({ dianEnvironment: m.dianEnvironment }));
vi.mock("@/lib/db", () => ({
  db: { dianDocument: { findUnique: m.dianDocumentFindUnique } },
}));

import { deliverInvoiceEmail, invoiceDeliveryMode } from "./invoiceDelivery";

const invoice = {
  invoiceId: "inv_1",
  invoiceNumber: 6485,
  invoiceUrl: "https://mesapay.co/factura/inv_1",
  snapshot: {} as never,
  email: "cliente@correo.com",
  locale: "es",
};
const SIN_FE = { id: "r1", enabledModules: [] as string[] };
const CON_FE = { id: "r1", enabledModules: ["einvoicing"] };

// El sendXxx son fire-and-forget (`void`): dejamos que el microtask corra.
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  m.dianDocumentFindUnique.mockResolvedValue(null);
});

describe("invoiceDeliveryMode — la regla, sin DB", () => {
  it("sin facturación electrónica es comprobante", () => {
    expect(invoiceDeliveryMode([])).toBe("comprobante");
    expect(invoiceDeliveryMode(null)).toBe("comprobante");
  });
  it("con facturación electrónica es factura electrónica", () => {
    expect(invoiceDeliveryMode(["einvoicing"])).toBe("factura_electronica");
  });
});

describe("comercio SIN facturación electrónica", () => {
  it("manda el comprobante en la primera emisión, como siempre", async () => {
    const r = await deliverInvoiceEmail({ tenant: SIN_FE, invoice, firstIssuance: true });
    await tick();
    expect(r).toEqual({ sent: "comprobante" });
    expect(m.sendSimpleInvoiceEmail).toHaveBeenCalledWith(
      expect.objectContaining({ email: "cliente@correo.com", invoiceId: "inv_1" }),
    );
    expect(m.sendDianInvoiceEmail).not.toHaveBeenCalled();
  });

  it("no repite el comprobante si la tirilla ya estaba emitida y el correo no es nuevo", async () => {
    const r = await deliverInvoiceEmail({ tenant: SIN_FE, invoice, firstIssuance: false });
    expect(r).toEqual({ sent: "none", reason: "not_first_issuance" });
    expect(m.sendSimpleInvoiceEmail).not.toHaveBeenCalled();
  });

  it("sí lo manda si el comensal acaba de dejar el correo sobre una tirilla ya emitida", async () => {
    const r = await deliverInvoiceEmail({
      tenant: SIN_FE, invoice, firstIssuance: false, emailJustProvided: true,
    });
    await tick();
    expect(r).toEqual({ sent: "comprobante" });
    expect(m.sendSimpleInvoiceEmail).toHaveBeenCalledTimes(1);
  });

  it("sin correo no manda nada", async () => {
    const r = await deliverInvoiceEmail({
      tenant: SIN_FE, invoice: { ...invoice, email: "  " }, firstIssuance: true,
    });
    expect(r).toEqual({ sent: "none", reason: "no_email" });
    expect(m.sendSimpleInvoiceEmail).not.toHaveBeenCalled();
  });
});

describe("comercio CON facturación electrónica: NUNCA el comprobante", () => {
  it("con la DIAN todavía sin aceptar, no manda nada (la aceptación lo dispara sola)", async () => {
    m.dianDocumentFindUnique.mockResolvedValue({ id: "d1", state: "to_send", emailedAt: null });
    const r = await deliverInvoiceEmail({ tenant: CON_FE, invoice, firstIssuance: true });
    await tick();
    expect(r).toEqual({ sent: "none", reason: "dian_not_ready" });
    expect(m.sendSimpleInvoiceEmail).not.toHaveBeenCalled();
    expect(m.sendDianInvoiceEmail).not.toHaveBeenCalled();
  });

  it("aceptada y nunca enviada ⇒ manda la factura electrónica (el correo llegó tarde)", async () => {
    m.dianDocumentFindUnique.mockResolvedValue({ id: "d1", state: "accepted", emailedAt: null });
    const r = await deliverInvoiceEmail({
      tenant: CON_FE, invoice, firstIssuance: false, emailJustProvided: true,
    });
    await tick();
    expect(r).toEqual({ sent: "factura_electronica" });
    expect(m.sendDianInvoiceEmail).toHaveBeenCalledWith({ documentId: "d1", environment: "produccion" });
    expect(m.sendSimpleInvoiceEmail).not.toHaveBeenCalled();
  });

  it("aceptada y ya enviada ⇒ no duplica", async () => {
    m.dianDocumentFindUnique.mockResolvedValue({ id: "d1", state: "accepted", emailedAt: new Date() });
    const r = await deliverInvoiceEmail({ tenant: CON_FE, invoice, firstIssuance: true });
    expect(r).toEqual({ sent: "none", reason: "already_emailed" });
    expect(m.sendDianInvoiceEmail).not.toHaveBeenCalled();
  });

  it("ni siquiera en la primera emisión sale el comprobante", async () => {
    const r = await deliverInvoiceEmail({ tenant: CON_FE, invoice, firstIssuance: true });
    await tick();
    expect(r.sent).not.toBe("comprobante");
    expect(m.sendSimpleInvoiceEmail).not.toHaveBeenCalled();
  });

  it("un fallo de la DB no lanza: devuelve error y no manda nada", async () => {
    m.dianDocumentFindUnique.mockRejectedValue(new Error("boom"));
    const r = await deliverInvoiceEmail({ tenant: CON_FE, invoice, firstIssuance: true });
    expect(r).toEqual({ sent: "none", reason: "error" });
    expect(m.sendSimpleInvoiceEmail).not.toHaveBeenCalled();
  });
});
