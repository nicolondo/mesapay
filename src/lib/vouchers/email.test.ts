import { describe, expect, it } from "vitest";
import { renderVoucherIssueEmail } from "./email";

const base = {
  restaurantName: "Son y Melona",
  customerName: "Acme S.A.S.",
  quantity: 2,
  unitValueCents: 300_000_00,
  totalCents: 600_000_00,
  currency: "COP",
  expiresAt: new Date("2026-12-31T04:59:59Z"),
  note: "Bonos navidad",
  vouchers: [
    { code: "SM7K3Q9X2A", valueCents: 300_000_00 },
    { code: "SMABCD2345", valueCents: 300_000_00 },
  ],
};

describe("renderVoucherIssueEmail", () => {
  it("prepago: lleva el link de pago y los códigos formateados, en el idioma pedido", async () => {
    const r = await renderVoucherIssueEmail({
      ...base,
      locale: "es",
      mode: "prepaid",
      paymentUrl: "https://mesapay.co/r/son-y-melona/pago/tok",
    });
    expect(r.subject).toBe("Son y Melona: 2 bonos emitidos para Acme S.A.S.");
    expect(r.html).toContain("https://mesapay.co/r/son-y-melona/pago/tok");
    expect(r.text).toContain("https://mesapay.co/r/son-y-melona/pago/tok");
    expect(r.html).toContain("SM-7K3Q-9X2A");
    expect(r.html).toContain("SM-ABCD-2345");
    expect(r.text).toContain("Bonos navidad");
    // Total en la moneda del comercio, sin sufijo ISO.
    expect(r.text).toContain("600.000");
    expect(r.html).toContain("prepagado");
    expect(r.html).not.toContain("a crédito");
  });

  it("crédito: sin link, explica que se cobra por corte", async () => {
    const r = await renderVoucherIssueEmail({ ...base, locale: "es", mode: "credit", paymentUrl: null });
    expect(r.html).not.toContain("/pago/");
    expect(r.html).toContain("a crédito");
    expect(r.text).toContain("corte");
  });

  it("el CSV adjunto trae un renglón por bono con su vencimiento", async () => {
    const r = await renderVoucherIssueEmail({ ...base, locale: "en", mode: "credit", paymentUrl: null });
    const lines = r.csv.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines[0]).toBe("Code,Value,Expires");
    expect(lines[1]).toBe("SM-7K3Q-9X2A,300000,2026-12-31");
    expect(lines).toHaveLength(3);
  });

  it("sin vencimiento lo dice y el CSV deja la columna vacía", async () => {
    const r = await renderVoucherIssueEmail({
      ...base,
      locale: "pt",
      mode: "credit",
      paymentUrl: null,
      expiresAt: null,
      note: null,
    });
    expect(r.text).toContain("Sem data de vencimento");
    expect(r.csv).toContain("SM-7K3Q-9X2A,300000,\r\n");
  });

  it("escapa HTML en lo que escribió el operador o el nombre de la empresa", async () => {
    const r = await renderVoucherIssueEmail({
      ...base,
      locale: "es",
      mode: "credit",
      paymentUrl: null,
      customerName: "<b>Acme</b>",
    });
    expect(r.html).toContain("&lt;b&gt;Acme&lt;/b&gt;");
    expect(r.html).not.toContain("<b>Acme</b>");
  });
});
