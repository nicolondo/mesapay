// Descuento del cliente de facturación sobre la cuenta: usa las mismas dos
// columnas del descuento por comensal, es idempotente y no pisa un
// descuento mayor que ya tuviera la cuenta.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./orderLock", () => ({ lockOrder: vi.fn(async () => {}) }));

import { applyCustomerDiscount, bpsToPct, customerDiscountCents } from "./customerDiscount";

const tx = {
  order: { findUnique: vi.fn(), update: vi.fn() },
  payment: { count: vi.fn() },
};
type Tx = Parameters<typeof applyCustomerDiscount>[0];

const baseOrder = {
  restaurantId: "r1",
  status: "open",
  subtotalCents: 100_000,
  taxCents: 0,
  tipCents: 0,
  discountPct: null as number | null,
  discountCents: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  tx.order.findUnique.mockResolvedValue({ ...baseOrder });
  tx.order.update.mockResolvedValue({});
  tx.payment.count.mockResolvedValue(0);
});

describe("customerDiscountCents / bpsToPct", () => {
  it("convierte puntos base y calcula exacto (12,5 % de 100.000 = 12.500)", () => {
    expect(bpsToPct(1250)).toBe(12.5);
    expect(customerDiscountCents(100_000, { discountEnabled: true, discountBps: 1250 })).toBe(12_500);
    expect(customerDiscountCents(100_000, { discountEnabled: true, discountBps: 1000 })).toBe(10_000);
  });
  it("sin descuento habilitado (o en 0) vale 0", () => {
    expect(customerDiscountCents(100_000, { discountEnabled: false, discountBps: 1000 })).toBe(0);
    expect(customerDiscountCents(100_000, { discountEnabled: true, discountBps: 0 })).toBe(0);
  });
});

describe("applyCustomerDiscount", () => {
  it("aplica el descuento escribiendo discountPct/discountCents y el total", async () => {
    const r = await applyCustomerDiscount(tx as unknown as Tx, "o1", "r1", { discountEnabled: true, discountBps: 1000 });
    expect(r).toEqual({ applied: true, changed: true, discountPct: 10, discountCents: 10_000, subtotalCents: 100_000 });
    expect(tx.order.update).toHaveBeenCalledWith({
      where: { id: "o1" },
      data: { discountPct: 10, discountCents: 10_000, totalCents: 90_000 },
    });
  });

  it("con porcentaje fraccional el valor es exacto y el % guardado, redondeado", async () => {
    const r = await applyCustomerDiscount(tx as unknown as Tx, "o1", "r1", { discountEnabled: true, discountBps: 1250 });
    expect(r).toMatchObject({ applied: true, discountPct: 13, discountCents: 12_500 });
    expect(tx.order.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { discountPct: 13, discountCents: 12_500, totalCents: 87_500 } }),
    );
  });

  it("es idempotente: si ya está aplicado el mismo descuento no escribe (ni aunque haya pagos)", async () => {
    tx.order.findUnique.mockResolvedValue({ ...baseOrder, status: "paying", discountPct: 10, discountCents: 10_000 });
    tx.payment.count.mockResolvedValue(2);
    const r = await applyCustomerDiscount(tx as unknown as Tx, "o1", "r1", { discountEnabled: true, discountBps: 1000 });
    expect(r).toEqual({ applied: true, changed: false, discountPct: 10, discountCents: 10_000, subtotalCents: 100_000 });
    expect(tx.order.update).not.toHaveBeenCalled();
  });

  it("no pisa un descuento manual mayor: lo conserva y avisa", async () => {
    tx.order.findUnique.mockResolvedValue({ ...baseOrder, discountPct: 20, discountCents: 20_000 });
    const r = await applyCustomerDiscount(tx as unknown as Tx, "o1", "r1", { discountEnabled: true, discountBps: 1000 });
    expect(r).toEqual({ applied: false, reason: "existing_greater", discountPct: 20, discountCents: 20_000, subtotalCents: 100_000 });
    expect(tx.order.update).not.toHaveBeenCalled();
  });

  it("un descuento menor existente sí se reemplaza por el del cliente", async () => {
    tx.order.findUnique.mockResolvedValue({ ...baseOrder, discountPct: 5, discountCents: 5_000 });
    const r = await applyCustomerDiscount(tx as unknown as Tx, "o1", "r1", { discountEnabled: true, discountBps: 1000 });
    expect(r).toMatchObject({ applied: true, changed: true, discountCents: 10_000 });
  });

  it("cliente sin descuento: no toca nada", async () => {
    const r = await applyCustomerDiscount(tx as unknown as Tx, "o1", "r1", { discountEnabled: false, discountBps: 1000 });
    expect(r).toEqual({ applied: false, reason: "no_discount", discountPct: null, discountCents: 0, subtotalCents: 100_000 });
    expect(tx.order.update).not.toHaveBeenCalled();
    expect(tx.payment.count).not.toHaveBeenCalled();
  });

  it("cuenta de otro comercio, cerrada o con pagos: no aplica", async () => {
    const customer = { discountEnabled: true, discountBps: 1000 };
    tx.order.findUnique.mockResolvedValue({ ...baseOrder, restaurantId: "otro" });
    expect((await applyCustomerDiscount(tx as unknown as Tx, "o1", "r1", customer)).applied).toBe(false);
    tx.order.findUnique.mockResolvedValue({ ...baseOrder, status: "paid" });
    expect(await applyCustomerDiscount(tx as unknown as Tx, "o1", "r1", customer)).toMatchObject({ reason: "not_applicable" });
    tx.order.findUnique.mockResolvedValue({ ...baseOrder });
    tx.payment.count.mockResolvedValue(1);
    expect(await applyCustomerDiscount(tx as unknown as Tx, "o1", "r1", customer)).toMatchObject({ reason: "not_applicable" });
    expect(tx.order.update).not.toHaveBeenCalled();
  });
});
