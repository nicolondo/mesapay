import { describe, expect, it } from "vitest";

import {
  DEFAULT_PHONE_PAID_HIGHLIGHT_MINUTES,
  RECENTLY_PAID_MINUTES,
  closingPayment,
  isPhonePaidHighlightActive,
  isRecentlyPaidVisible,
  minutesSincePaid,
  resolvePhonePaidHighlightMinutes,
  wasPaidFromPhone,
  type PhonePaidPayment,
} from "./phonePaid";

/**
 * "Cuando una mesa acaba de pagar directamente desde el móvil quiero que
 * salga en verde de primera por los siguientes 3 minutos." Pagó desde el
 * celular = el pago que cerró la cuenta es de pasarela en línea y nadie del
 * equipo lo inició.
 */

const T0 = Date.parse("2026-11-02T20:00:00Z");
const min = (n: number) => n * 60_000;

function payment(
  method: string,
  at: number,
  extra: Partial<PhonePaidPayment> = {},
): PhonePaidPayment {
  return {
    method,
    status: "approved",
    collectedByUserId: null,
    settledAt: new Date(at),
    createdAt: new Date(at - min(1)),
    ...extra,
  };
}

describe("wasPaidFromPhone", () => {
  it("tarjeta desde el QR, sin nadie del equipo → sí", () => {
    expect(wasPaidFromPhone([payment("kushki_card", T0)])).toBe(true);
  });

  it("Apple Pay, Google Pay y PSE desde el celular → sí", () => {
    for (const m of ["kushki_apple_pay", "kushki_google_pay", "kushki_pse"]) {
      expect(wasPaidFromPhone([payment(m, T0)]), m).toBe(true);
    }
  });

  it("la misma tarjeta cobrada por un mesero desde su PWA → no (él ya sabe)", () => {
    expect(
      wasPaidFromPhone([payment("kushki_card", T0, { collectedByUserId: "mesero1" })]),
    ).toBe(false);
  });

  it("efectivo y datáfonos nunca cuentan, aunque nadie quede registrado", () => {
    for (const m of ["cash", "demo_cash", "external_terminal", "kushki_card_terminal"]) {
      expect(wasPaidFromPhone([payment(m, T0)]), m).toBe(false);
    }
  });

  it("abono de reserva, bono y crédito tampoco", () => {
    for (const m of ["reservation_deposit", "voucher", "customer_credit"]) {
      expect(wasPaidFromPhone([payment(m, T0)]), m).toBe(false);
    }
  });

  it("decide el pago que CERRÓ la cuenta: celular y después efectivo al mesero → no", () => {
    const payments = [
      payment("kushki_card", T0),
      payment("cash", T0 + min(2), { collectedByUserId: "mesero1" }),
    ];
    expect(wasPaidFromPhone(payments)).toBe(false);
  });

  it("efectivo al mesero y después el resto por celular → sí", () => {
    const payments = [
      payment("cash", T0, { collectedByUserId: "mesero1" }),
      payment("kushki_apple_pay", T0 + min(2)),
    ];
    expect(wasPaidFromPhone(payments)).toBe(true);
  });

  it("abono de reserva al sentarse y el saldo por celular → sí", () => {
    const payments = [
      payment("reservation_deposit", T0 - min(60)),
      payment("kushki_pse", T0),
    ];
    expect(wasPaidFromPhone(payments)).toBe(true);
  });

  it("ignora pendientes, rechazados y reembolsados", () => {
    const payments = [
      payment("cash", T0 - min(5), { collectedByUserId: "m1" }),
      payment("kushki_card", T0, { status: "pending" }),
      payment("kushki_card", T0 + min(1), { status: "declined" }),
      payment("kushki_card", T0 + min(2), { status: "refunded" }),
    ];
    expect(wasPaidFromPhone(payments)).toBe(false);
  });

  it("sin pagos aprobados (cortesía, cuenta en $0) → no", () => {
    expect(wasPaidFromPhone([])).toBe(false);
    expect(wasPaidFromPhone([payment("kushki_card", T0, { status: "pending" })])).toBe(false);
  });

  it("acepta fechas ISO (como llegan al cliente) y usa createdAt si falta settledAt", () => {
    const payments: PhonePaidPayment[] = [
      {
        method: "kushki_card",
        status: "approved",
        collectedByUserId: null,
        settledAt: null,
        createdAt: new Date(T0).toISOString(),
      },
      {
        method: "cash",
        status: "approved",
        collectedByUserId: "m1",
        settledAt: new Date(T0 - min(3)).toISOString(),
        createdAt: new Date(T0 - min(4)).toISOString(),
      },
    ];
    expect(closingPayment(payments)?.method).toBe("kushki_card");
    expect(wasPaidFromPhone(payments)).toBe(true);
  });
});

describe("isPhonePaidHighlightActive", () => {
  it("vigente mientras no pasen los minutos del comercio", () => {
    expect(isPhonePaidHighlightActive(T0, T0, 3)).toBe(true);
    expect(isPhonePaidHighlightActive(T0, T0 + min(2.9), 3)).toBe(true);
  });

  it("cae justo al cumplirse los minutos", () => {
    expect(isPhonePaidHighlightActive(T0, T0 + min(3), 3)).toBe(false);
    expect(isPhonePaidHighlightActive(T0, T0 + min(10), 3)).toBe(false);
  });

  it("0 minutos = apagado, aunque acabe de pagar", () => {
    expect(isPhonePaidHighlightActive(T0, T0, 0)).toBe(false);
    expect(isPhonePaidHighlightActive(T0, T0, -5)).toBe(false);
  });

  it("un pago 'en el futuro' (reloj del cliente atrasado) cuenta como recién pagado", () => {
    expect(isPhonePaidHighlightActive(T0 + min(1), T0, 3)).toBe(true);
  });

  it("acepta Date e ISO; una fecha inválida nunca resalta", () => {
    expect(isPhonePaidHighlightActive(new Date(T0), T0 + min(1), 3)).toBe(true);
    expect(isPhonePaidHighlightActive(new Date(T0).toISOString(), T0 + min(1), 3)).toBe(true);
    expect(isPhonePaidHighlightActive("no-es-fecha", T0, 3)).toBe(false);
  });
});

describe("isRecentlyPaidVisible", () => {
  const staff = { paidFromPhone: false, phonePaidHighlightMinutes: 3 };
  const phone = { paidFromPhone: true, phonePaidHighlightMinutes: 3 };

  it("cualquier recién pagada se ve 15 minutos y después es libre", () => {
    expect(RECENTLY_PAID_MINUTES).toBe(15);
    expect(isRecentlyPaidVisible(T0, T0 + min(14.9), staff)).toBe(true);
    expect(isRecentlyPaidVisible(T0, T0 + min(15), staff)).toBe(false);
    expect(isRecentlyPaidVisible(T0, T0 + min(15), phone)).toBe(false);
  });

  it("un resalte más largo que 15 minutos la mantiene visible mientras dure", () => {
    const longPhone = { paidFromPhone: true, phonePaidHighlightMinutes: 30 };
    expect(isRecentlyPaidVisible(T0, T0 + min(20), longPhone)).toBe(true);
    expect(isRecentlyPaidVisible(T0, T0 + min(30), longPhone)).toBe(false);
    // Cobrada por el mesero: el resalte largo no le aplica.
    expect(isRecentlyPaidVisible(T0, T0 + min(20), { ...longPhone, paidFromPhone: false })).toBe(false);
  });

  it("fecha inválida → no se dibuja", () => {
    expect(isRecentlyPaidVisible("no-es-fecha", T0, phone)).toBe(false);
  });
});

describe("minutesSincePaid", () => {
  it("minutos enteros, nunca negativos", () => {
    expect(minutesSincePaid(T0, T0)).toBe(0);
    expect(minutesSincePaid(T0, T0 + min(1.9))).toBe(1);
    expect(minutesSincePaid(T0, T0 + min(2))).toBe(2);
    expect(minutesSincePaid(T0 + min(5), T0)).toBe(0);
  });
});

describe("resolvePhonePaidHighlightMinutes", () => {
  it("default 3 cuando no hay valor", () => {
    expect(DEFAULT_PHONE_PAID_HIGHLIGHT_MINUTES).toBe(3);
    expect(resolvePhonePaidHighlightMinutes(null)).toBe(3);
    expect(resolvePhonePaidHighlightMinutes(undefined)).toBe(3);
    expect(resolvePhonePaidHighlightMinutes(Number.NaN)).toBe(3);
  });

  it("respeta lo configurado dentro de 0–30 y recorta lo demás", () => {
    expect(resolvePhonePaidHighlightMinutes(0)).toBe(0);
    expect(resolvePhonePaidHighlightMinutes(10)).toBe(10);
    expect(resolvePhonePaidHighlightMinutes(30)).toBe(30);
    expect(resolvePhonePaidHighlightMinutes(45)).toBe(30);
    expect(resolvePhonePaidHighlightMinutes(-2)).toBe(0);
    expect(resolvePhonePaidHighlightMinutes(4.7)).toBe(4);
  });
});
