import { describe, it, expect } from "vitest";
import {
  computeDiscountCents,
  isValidDiscountPct,
  recalcDiscountForSubtotal,
} from "./customerDiscount";
import { computeOrderTotals } from "./orderTotals";

describe("computeDiscountCents", () => {
  it("aplica el porcentaje sobre el subtotal", () => {
    expect(computeDiscountCents(100_000, 10)).toBe(10_000);
    expect(computeDiscountCents(45_500, 20)).toBe(9_100);
  });

  it("redondea al peso más cercano", () => {
    // 33.333 → 3.333 con 10 %: media redondeada, no truncada.
    expect(computeDiscountCents(3_333, 10)).toBe(333);
    expect(computeDiscountCents(3_335, 10)).toBe(334);
  });

  it("devuelve 0 sin porcentaje o con cuenta vacía", () => {
    expect(computeDiscountCents(100_000, null)).toBe(0);
    expect(computeDiscountCents(100_000, undefined)).toBe(0);
    expect(computeDiscountCents(100_000, 0)).toBe(0);
    expect(computeDiscountCents(0, 10)).toBe(0);
  });

  it("nunca supera el subtotal — la cuenta no puede quedar negativa", () => {
    expect(computeDiscountCents(50_000, 100)).toBe(50_000);
    expect(computeDiscountCents(50_000, 250)).toBe(50_000);
  });
});

describe("isValidDiscountPct", () => {
  it("acepta enteros entre 1 y 100", () => {
    expect(isValidDiscountPct(1)).toBe(true);
    expect(isValidDiscountPct(100)).toBe(true);
  });

  it("rechaza 0, negativos, mayores a 100 y decimales", () => {
    expect(isValidDiscountPct(0)).toBe(false);
    expect(isValidDiscountPct(-5)).toBe(false);
    expect(isValidDiscountPct(101)).toBe(false);
    expect(isValidDiscountPct(12.5)).toBe(false);
  });
});

describe("recalcDiscountForSubtotal", () => {
  it("sigue al subtotal cuando el comensal pide más", () => {
    // Lo pactado es el PORCENTAJE; el valor en pesos tiene que moverse
    // con la cuenta o el descuento quedaría congelado en el primer plato.
    const order = { discountPct: 15 };
    expect(recalcDiscountForSubtotal(order, 100_000)).toBe(15_000);
    expect(recalcDiscountForSubtotal(order, 200_000)).toBe(30_000);
  });

  it("queda en 0 si el mesero quitó el descuento", () => {
    expect(recalcDiscountForSubtotal({ discountPct: null }, 200_000)).toBe(0);
  });
});

describe("computeOrderTotals con descuento", () => {
  it("baja lo cobrable, no el subtotal", () => {
    // Con 10 % sobre 100.000 el comensal debe 90.000. Si el descuento no
    // entrara al cálculo, el tope de pago rechazaría el cobro correcto.
    const totals = computeOrderTotals(100_000, [], 0, 10_000);
    expect(totals.outstandingCents).toBe(90_000);
    expect(totals.fullyPaid).toBe(false);
  });

  it("da la cuenta por pagada al cubrir el neto, no el bruto", () => {
    const totals = computeOrderTotals(
      100_000,
      [{ amountCents: 90_000, tipCents: 0 }],
      0,
      10_000,
    );
    expect(totals.fullyPaid).toBe(true);
    expect(totals.outstandingCents).toBe(0);
  });

  it("no cuenta la propina contra el saldo", () => {
    const totals = computeOrderTotals(
      100_000,
      [{ amountCents: 99_000, tipCents: 9_000 }],
      0,
      10_000,
    );
    expect(totals.foodPaidCents).toBe(90_000);
    expect(totals.fullyPaid).toBe(true);
  });

  it("sin descuento se comporta exactamente como antes", () => {
    const before = computeOrderTotals(100_000, [], 0);
    expect(before.outstandingCents).toBe(100_000);
  });

  it("un descuento mayor que la cuenta la deja en 0, nunca en negativo", () => {
    const totals = computeOrderTotals(50_000, [], 0, 80_000);
    expect(totals.outstandingCents).toBe(0);
    expect(totals.fullyPaid).toBe(true);
  });
});
