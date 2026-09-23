import { describe, expect, it } from "vitest";
import { renderVoucherStatementEmail } from "./statementEmail";

const base = {
  restaurantName: "Son y Melona",
  customerName: "Acme S.A.S.",
  periodFrom: new Date("2026-09-01T05:00:00Z"),
  periodTo: new Date("2026-09-15T05:00:00Z"),
  currency: "COP",
  rows: [
    { redeemedAt: new Date("2026-09-03T17:00:00Z"), code: "SM-7K3Q-9X2A", orderCode: "002A77-77C496-58E6EF-6C25C8", amountCents: 300_000_00 },
    { redeemedAt: new Date("2026-09-10T20:00:00Z"), code: "SM-ABCD-2345", orderCode: "1B9F02-4D8A6E-C31A55-9E7B20", amountCents: 120_000_00 },
  ],
};

describe("renderVoucherStatementEmail", () => {
  it("crédito: lleva el link de pago por lo de crédito", async () => {
    const r = await renderVoucherStatementEmail({
      ...base,
      locale: "es",
      totalCents: 420_000_00,
      creditCents: 420_000_00,
      prepaidCents: 0,
      paymentUrl: "https://mesapay.co/r/son-y-melona/pago/tok-st",
    });
    expect(r.subject).toContain("Son y Melona");
    expect(r.html).toContain("https://mesapay.co/r/son-y-melona/pago/tok-st");
    expect(r.text).toContain("https://mesapay.co/r/son-y-melona/pago/tok-st");
    expect(r.text).toContain("420.000");
    expect(r.html).toContain("SM-7K3Q-9X2A");
    // La cuenta va con el código corto (primer grupo) en el correo; el CSV
    // adjunto conserva el código completo para conciliar.
    expect(r.html).toContain(">002A77<");
    expect(r.html).not.toContain("002A77-77C496");
    expect(r.text).toContain("  002A77  ");
    expect(r.csv).toContain("002A77-77C496-58E6EF-6C25C8");
    expect(r.html).not.toContain("prepagados");
  });

  it("prepago: sin link, informa que ya estaba pagado", async () => {
    const r = await renderVoucherStatementEmail({
      ...base,
      locale: "es",
      totalCents: 420_000_00,
      creditCents: 0,
      prepaidCents: 420_000_00,
      paymentUrl: null,
    });
    expect(r.html).not.toContain("/pago/");
    expect(r.text).toContain("prepagados");
    expect(r.text).not.toContain("Pagar ");
  });

  it("mixto: separa crédito (con link) de lo prepagado", async () => {
    const r = await renderVoucherStatementEmail({
      ...base,
      locale: "en",
      totalCents: 420_000_00,
      creditCents: 300_000_00,
      prepaidCents: 120_000_00,
      paymentUrl: "https://mesapay.co/r/x/pago/t",
    });
    expect(r.text).toContain("on credit");
    expect(r.text).toContain("prepaid vouchers");
    expect(r.text).toContain("Pay ");
  });

  it("el CSV trae un renglón por uso", async () => {
    const r = await renderVoucherStatementEmail({
      ...base,
      locale: "pt",
      totalCents: 420_000_00,
      creditCents: 420_000_00,
      prepaidCents: 0,
      paymentUrl: null,
    });
    const lines = r.csv.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines[0]).toBe("Data,Vale,Conta,Resgatado");
    expect(lines[1]).toBe("2026-09-03,SM-7K3Q-9X2A,002A77-77C496-58E6EF-6C25C8,300000");
    expect(lines).toHaveLength(3);
  });
});
