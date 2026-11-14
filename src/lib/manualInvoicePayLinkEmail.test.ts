import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Correo de la factura manual con su link de pago: con la factura YA
 * emitida (electrónica aceptada con CUFE y XML, o todavía en la DIAN, o el
 * comprobante) y como "cuenta por pagar" cuando la factura se emite al
 * pagar. Medios: sólo los en línea que ofrece el link. Un correo por
 * destinatario, con el adjunto.
 */
const m = vi.hoisted(() => ({ sendEmail: vi.fn() }));
vi.mock("@/lib/mailer", () => ({ sendEmail: m.sendEmail }));

import { renderManualInvoicePayLinkEmail, sendManualInvoicePayLinkEmail } from "./manualInvoicePayLinkEmail";

const base = {
  locale: "es",
  restaurantName: "Restaurante Demo",
  orderCode: "ABC123-DEF456",
  totalCents: 10_800_000,
  currency: "COP",
  lines: [{ name: "Catering evento", qty: 1, amountCents: 10_000_000 }],
  payUrl: "https://mesapay.co/r/restaurante-demo/cuenta/tok123",
  expiresAt: new Date("2026-11-20T15:00:00Z"),
  customerName: "Empresa Demo S.A.S.",
};

beforeEach(() => {
  vi.clearAllMocks();
  m.sendEmail.mockResolvedValue(true);
});

describe("renderManualInvoicePayLinkEmail", () => {
  it("factura electrónica aceptada: número, enlace a la representación, CUFE, validar en la DIAN y aviso del XML", async () => {
    const r = await renderManualInvoicePayLinkEmail({
      ...base,
      invoice: {
        kind: "issued",
        number: "FE-120",
        url: "https://mesapay.co/factura/inv1",
        electronic: { cufe: "abc123cufe", verifyUrl: "https://catalogo-vpfe.dian.gov.co/document/searchqr?documentkey=abc123cufe", attached: true },
        pendingDian: false,
      },
      methods: ["kushki_card", "kushki_apple_pay", "kushki_pse", "kushki_bre_b"],
      dueDate: new Date("2026-12-02T15:00:00Z"),
    });
    expect(r.subject).toMatch(/^Restaurante Demo: factura FE-120 por \$\s108,000$/);
    expect(r.html).toContain("Factura FE-120");
    expect(r.html).toContain("https://mesapay.co/factura/inv1");
    expect(r.html).toContain("CUFE: abc123cufe");
    expect(r.html).toContain("Validar en la DIAN");
    expect(r.html).toContain("Adjuntamos el XML de la factura electrónica.");
    expect(r.html).toContain(base.payUrl);
    // Vencimiento de la factura (por cobrar), no la vida del link.
    expect(r.text).toContain("La factura vence el 2 de diciembre de 2026.");
    expect(r.text).toContain("Puedes pagar con tarjeta de crédito o débito, Apple Pay (en iPhone o Mac), PSE o Bre-B.");
    expect(r.text).not.toMatch(/efectivo|datáfono/i);
    expect(r.text).toContain("Hola, Empresa Demo S.A.S.");
  });

  it("factura electrónica todavía en la DIAN: lo dice, sin CUFE", async () => {
    const r = await renderManualInvoicePayLinkEmail({
      ...base,
      invoice: { kind: "issued", number: "FE-121", url: "https://mesapay.co/factura/inv2", electronic: null, pendingDian: true },
    });
    expect(r.text).toContain("La DIAN está validando la factura electrónica");
    expect(r.html).not.toContain("CUFE");
  });

  it("todavía sin factura: «cuenta por pagar» y la factura electrónica llega al pagar", async () => {
    const r = await renderManualInvoicePayLinkEmail({
      ...base,
      invoice: { kind: "on_payment", electronic: true },
      methods: ["kushki_card", "kushki_pse"],
    });
    expect(r.subject).toMatch(/^Restaurante Demo: link para pagar la cuenta ABC123 por \$\s108,000$/);
    expect(r.html).toContain("Cuenta por pagar");
    expect(r.text).toContain("La factura electrónica se emite cuando pagues y te llega por correo.");
    expect(r.text).toContain("Puedes pagar con tarjeta de crédito o débito o PSE.");
    expect(r.text).toContain("El enlace sirve hasta el");
    expect(r.html).toContain("Catering evento");
  });

  it("en el idioma de la cuenta (inglés y portugués)", async () => {
    const en = await renderManualInvoicePayLinkEmail({
      ...base,
      locale: "en",
      invoice: { kind: "issued", number: "FE-120", url: "https://mesapay.co/factura/inv1", electronic: null, pendingDian: false },
      methods: ["kushki_card", "kushki_pse"],
    });
    expect(en.subject).toContain("invoice FE-120");
    expect(en.text).toContain("You can pay with credit or debit card or PSE.");
    const pt = await renderManualInvoicePayLinkEmail({ ...base, locale: "pt", invoice: { kind: "on_payment", electronic: true } });
    expect(pt.text).toContain("A fatura eletrônica é emitida quando você pagar");
  });

  it("escapa el contenido del comercio", async () => {
    const r = await renderManualInvoicePayLinkEmail({ ...base, lines: [{ name: "<b>x</b>", qty: 1, amountCents: 1 }] });
    expect(r.html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(r.html).not.toContain("<b>x</b>");
  });
});

describe("sendManualInvoicePayLinkEmail", () => {
  it("un correo por destinatario, con el adjunto, y dice a quiénes salió", async () => {
    m.sendEmail.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const attachment = { filename: "ad0900000001.zip", content: "UEsDBA==", contentType: "application/zip" };
    const r = await sendManualInvoicePayLinkEmail({
      ...base,
      to: ["pagos@empresa.com", "contabilidad@empresa.com"],
      attachments: [attachment],
    });
    expect(r).toEqual({ sent: ["pagos@empresa.com"], failed: ["contabilidad@empresa.com"] });
    expect(m.sendEmail).toHaveBeenCalledTimes(2);
    expect(m.sendEmail.mock.calls.map((c) => c[0].to)).toEqual(["pagos@empresa.com", "contabilidad@empresa.com"]);
    expect(m.sendEmail.mock.calls[0][0].attachments).toEqual([attachment]);
  });
});
