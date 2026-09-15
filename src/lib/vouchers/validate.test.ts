import { describe, expect, it } from "vitest";
import { voucherApplicableCents, voucherRedeemability } from "./validate";

const now = new Date("2026-09-15T12:00:00Z");
const active = { status: "active" as const, balanceCents: 300_000_00, expiresAt: null };
const paid = { mode: "prepaid" as const, status: "paid" as const };
const credit = { mode: "credit" as const, status: "issued" as const };

describe("voucherRedeemability", () => {
  it("un bono activo de un lote pagado (o a crédito) se puede usar", () => {
    expect(voucherRedeemability(active, paid, now)).toBe("ok");
    expect(voucherRedeemability(active, credit, now)).toBe("ok");
  });
  it("prepago sin pagar: nadie come con esos códigos todavía", () => {
    expect(voucherRedeemability(active, { mode: "prepaid", status: "issued" }, now)).toBe(
      "batch_unpaid",
    );
  });
  it("el lote cancelado manda sobre todo lo demás", () => {
    expect(voucherRedeemability(active, { mode: "credit", status: "cancelled" }, now)).toBe(
      "batch_cancelled",
    );
  });
  it("cancelado, vencido (por estado o por fecha) y agotado", () => {
    expect(voucherRedeemability({ ...active, status: "cancelled" }, paid, now)).toBe("cancelled");
    expect(voucherRedeemability({ ...active, status: "expired" }, paid, now)).toBe("expired");
    expect(
      voucherRedeemability({ ...active, expiresAt: new Date("2026-09-14T00:00:00Z") }, paid, now),
    ).toBe("expired");
    expect(
      voucherRedeemability({ ...active, expiresAt: new Date("2026-12-31T00:00:00Z") }, paid, now),
    ).toBe("ok");
    expect(voucherRedeemability({ ...active, balanceCents: 0 }, paid, now)).toBe("exhausted");
    expect(voucherRedeemability({ ...active, status: "exhausted" }, paid, now)).toBe("exhausted");
  });
});

describe("voucherApplicableCents", () => {
  it("cuenta más grande que el bono: se aplica todo el saldo y el resto lo paga el comensal", () => {
    expect(voucherApplicableCents(300_000_00, 450_000_00)).toBe(300_000_00);
  });
  it("cuenta más chica: se aplica lo pendiente y el saldo queda para la próxima", () => {
    expect(voucherApplicableCents(300_000_00, 120_000_00)).toBe(120_000_00);
  });
  it("nunca negativo", () => {
    expect(voucherApplicableCents(0, 100)).toBe(0);
    expect(voucherApplicableCents(100, -5)).toBe(0);
  });
});
