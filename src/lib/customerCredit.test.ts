// Crédito a clientes: deuda, aplicación FIFO de abonos y tope de crédito.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import {
  allocateFifo,
  canChargeOnCredit,
  chargeDebtCents,
  customerDebt,
  type CreditAbono,
  type CreditCharge,
} from "./customerCredit";

const charge = (id: string, date: string, amountCents: number, over: Partial<CreditCharge> = {}): CreditCharge => ({
  id,
  date: new Date(date),
  amountCents,
  tipCents: 0,
  refundedCents: 0,
  ...over,
});
const abono = (id: string, date: string, amountCents: number): CreditAbono => ({
  id,
  date: new Date(date),
  amountCents,
});

describe("customerDebt", () => {
  it("suma los cargos con propina y resta los abonos", () => {
    const charges = [
      charge("c1", "2026-09-01", 120_000, { tipCents: 20_000 }),
      charge("c2", "2026-09-05", 80_000),
    ];
    expect(customerDebt(charges, [])).toBe(200_000);
    expect(customerDebt(charges, [abono("a1", "2026-09-10", 50_000)])).toBe(150_000);
  });
  it("un cargo devuelto (parcial o total) pesa menos", () => {
    expect(chargeDebtCents({ amountCents: 100_000, refundedCents: 30_000 })).toBe(70_000);
    expect(chargeDebtCents({ amountCents: 100_000, refundedCents: 100_000 })).toBe(0);
    expect(customerDebt([charge("c1", "2026-09-01", 100_000, { refundedCents: 100_000 })], [])).toBe(0);
  });
  it("sin cargos ni abonos la deuda es 0; pagar de más da negativo", () => {
    expect(customerDebt([], [])).toBe(0);
    expect(customerDebt([charge("c1", "2026-09-01", 10_000)], [abono("a1", "2026-09-02", 15_000)])).toBe(-5_000);
  });
});

describe("allocateFifo", () => {
  it("aplica cada abono al cargo más viejo primero, aunque las listas vengan desordenadas", () => {
    const charges = [
      charge("nuevo", "2026-09-10", 50_000),
      charge("viejo", "2026-09-01", 100_000),
    ];
    const r = allocateFifo(charges, [abono("a1", "2026-09-12", 120_000)]);
    expect(r.charges).toEqual([
      { chargeId: "viejo", totalCents: 100_000, paidCents: 100_000, outstandingCents: 0 },
      { chargeId: "nuevo", totalCents: 50_000, paidCents: 20_000, outstandingCents: 30_000 },
    ]);
    expect(r.allocations).toEqual([
      { paymentId: "a1", chargeId: "viejo", cents: 100_000 },
      { paymentId: "a1", chargeId: "nuevo", cents: 20_000 },
    ]);
    expect(r.unappliedCents).toBe(0);
  });
  it("varios abonos se encadenan sobre el mismo cargo y siguen con el siguiente", () => {
    const charges = [charge("c1", "2026-09-01", 100_000), charge("c2", "2026-09-02", 100_000)];
    const r = allocateFifo(charges, [
      abono("a2", "2026-09-06", 70_000),
      abono("a1", "2026-09-05", 40_000),
    ]);
    // a1 (más viejo) cubre 40 del c1; a2 cubre los 60 restantes de c1 y 10 de c2.
    expect(r.allocations).toEqual([
      { paymentId: "a1", chargeId: "c1", cents: 40_000 },
      { paymentId: "a2", chargeId: "c1", cents: 60_000 },
      { paymentId: "a2", chargeId: "c2", cents: 10_000 },
    ]);
    expect(r.charges.map((c) => c.outstandingCents)).toEqual([0, 90_000]);
  });
  it("un cargo devuelto no consume abonos y lo pagado de más queda sin aplicar", () => {
    const charges = [
      charge("dev", "2026-09-01", 100_000, { refundedCents: 100_000 }),
      charge("c2", "2026-09-02", 30_000),
    ];
    const r = allocateFifo(charges, [abono("a1", "2026-09-03", 50_000)]);
    expect(r.charges[0]).toEqual({ chargeId: "dev", totalCents: 0, paidCents: 0, outstandingCents: 0 });
    expect(r.charges[1].outstandingCents).toBe(0);
    expect(r.unappliedCents).toBe(20_000);
  });
  it("sin abonos cada cargo queda entero pendiente", () => {
    const r = allocateFifo([charge("c1", "2026-09-01", 10_000)], []);
    expect(r.charges).toEqual([{ chargeId: "c1", totalCents: 10_000, paidCents: 0, outstandingCents: 10_000 }]);
    expect(r.allocations).toEqual([]);
  });
});

describe("canChargeOnCredit", () => {
  it("rechaza al cliente sin crédito habilitado aunque no deba nada", () => {
    expect(
      canChargeOnCredit({ customer: { creditEnabled: false, creditLimitCents: null }, debtCents: 0, amountCents: 1 }),
    ).toEqual({ ok: false, error: "credit_disabled" });
  });
  it("sin tope acepta cualquier monto", () => {
    expect(
      canChargeOnCredit({
        customer: { creditEnabled: true, creditLimitCents: null },
        debtCents: 9_000_000,
        amountCents: 5_000_000,
      }),
    ).toEqual({ ok: true });
  });
  it("con tope: deuda + cobro no puede pasarlo; justo en el tope pasa", () => {
    const customer = { creditEnabled: true, creditLimitCents: 500_000 };
    expect(canChargeOnCredit({ customer, debtCents: 300_000, amountCents: 200_000 })).toEqual({ ok: true });
    expect(canChargeOnCredit({ customer, debtCents: 300_000, amountCents: 200_001 })).toEqual({
      ok: false,
      error: "credit_limit_exceeded",
      availableCents: 200_000,
    });
  });
  it("con la deuda por encima del tope el cupo disponible es 0, no negativo", () => {
    expect(
      canChargeOnCredit({
        customer: { creditEnabled: true, creditLimitCents: 100_000 },
        debtCents: 150_000,
        amountCents: 1,
      }),
    ).toEqual({ ok: false, error: "credit_limit_exceeded", availableCents: 0 });
  });
});
