// Descuento del cliente de facturación sobre la cuenta: usa las mismas dos
// columnas del descuento por comensal, es idempotente y no pisa un
// descuento mayor que ya tuviera la cuenta.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./orderLock", () => ({ lockOrder: vi.fn(async () => {}) }));

import {
  applyCustomerDiscount,
  bpsToPct,
  customerDiscountCents,
  revertCustomerDiscountInTx,
} from "./customerDiscount";

const tx = {
  order: { findUnique: vi.fn(), update: vi.fn() },
  payment: { count: vi.fn() },
  simpleInvoice: { count: vi.fn() },
  auditEvent: { create: vi.fn() },
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
  tx.simpleInvoice.count.mockResolvedValue(0);
});

describe("applyCustomerDiscount — cuenta ya facturada (factura antes de cobrar)", () => {
  it("no cambia lo cobrable: el descuento quedó congelado en la factura", async () => {
    tx.simpleInvoice.count.mockResolvedValue(1);
    const r = await applyCustomerDiscount(tx as unknown as Tx, "o1", "r1", { id: "cust-1", discountEnabled: true, discountBps: 1000 });
    expect(r).toMatchObject({ applied: false, reason: "not_applicable", discountCents: 0 });
    expect(tx.order.update).not.toHaveBeenCalled();
  });
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
  it("aplica el descuento escribiendo discountPct/discountCents, el total y su ORIGEN (cliente + hora)", async () => {
    const before = Date.now();
    const r = await applyCustomerDiscount(tx as unknown as Tx, "o1", "r1", { id: "cust-1", discountEnabled: true, discountBps: 1000 });
    expect(r).toEqual({ applied: true, changed: true, discountPct: 10, discountCents: 10_000, subtotalCents: 100_000 });
    expect(tx.order.update).toHaveBeenCalledWith({
      where: { id: "o1" },
      data: {
        discountPct: 10,
        discountCents: 10_000,
        totalCents: 90_000,
        discountBillingCustomerId: "cust-1",
        discountAppliedAt: expect.any(Date),
      },
    });
    const data = tx.order.update.mock.calls[0][0].data as { discountAppliedAt: Date };
    expect(data.discountAppliedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("con porcentaje fraccional el valor es exacto y el % guardado, redondeado", async () => {
    const r = await applyCustomerDiscount(tx as unknown as Tx, "o1", "r1", { id: "cust-1", discountEnabled: true, discountBps: 1250 });
    expect(r).toMatchObject({ applied: true, discountPct: 13, discountCents: 12_500 });
    expect(tx.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ discountPct: 13, discountCents: 12_500, totalCents: 87_500 }),
      }),
    );
  });

  it("es idempotente: si ya está aplicado el mismo descuento no escribe (ni aunque haya pagos)", async () => {
    tx.order.findUnique.mockResolvedValue({ ...baseOrder, status: "paying", discountPct: 10, discountCents: 10_000 });
    tx.payment.count.mockResolvedValue(2);
    const r = await applyCustomerDiscount(tx as unknown as Tx, "o1", "r1", { id: "cust-1", discountEnabled: true, discountBps: 1000 });
    expect(r).toEqual({ applied: true, changed: false, discountPct: 10, discountCents: 10_000, subtotalCents: 100_000 });
    expect(tx.order.update).not.toHaveBeenCalled();
  });

  it("no pisa un descuento manual mayor: lo conserva y avisa", async () => {
    tx.order.findUnique.mockResolvedValue({ ...baseOrder, discountPct: 20, discountCents: 20_000 });
    const r = await applyCustomerDiscount(tx as unknown as Tx, "o1", "r1", { id: "cust-1", discountEnabled: true, discountBps: 1000 });
    expect(r).toEqual({ applied: false, reason: "existing_greater", discountPct: 20, discountCents: 20_000, subtotalCents: 100_000 });
    expect(tx.order.update).not.toHaveBeenCalled();
  });

  it("un descuento menor existente sí se reemplaza por el del cliente", async () => {
    tx.order.findUnique.mockResolvedValue({ ...baseOrder, discountPct: 5, discountCents: 5_000 });
    const r = await applyCustomerDiscount(tx as unknown as Tx, "o1", "r1", { id: "cust-1", discountEnabled: true, discountBps: 1000 });
    expect(r).toMatchObject({ applied: true, changed: true, discountCents: 10_000 });
  });

  it("cliente sin descuento: no toca nada", async () => {
    const r = await applyCustomerDiscount(tx as unknown as Tx, "o1", "r1", { id: "cust-1", discountEnabled: false, discountBps: 1000 });
    expect(r).toEqual({ applied: false, reason: "no_discount", discountPct: null, discountCents: 0, subtotalCents: 100_000 });
    expect(tx.order.update).not.toHaveBeenCalled();
    expect(tx.payment.count).not.toHaveBeenCalled();
  });

  it("cuenta de otro comercio, cerrada o con pagos: no aplica", async () => {
    const customer = { id: "cust-1", discountEnabled: true, discountBps: 1000 };
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

// ── Reversión: el descuento del paso «Cliente» pertenece a ESE cobro ──────

const discounted = {
  restaurantId: "r1",
  status: "served",
  subtotalCents: 100_000,
  taxCents: 0,
  tipCents: 0,
  discountPct: 20,
  discountCents: 20_000,
  discountBillingCustomerId: "cust-1",
  table: { kind: "standard" },
};

describe("revertCustomerDiscountInTx", () => {
  it("cobro rechazado: la cuenta vuelve sin el descuento del cliente y queda rastro", async () => {
    tx.order.findUnique.mockResolvedValue({ ...discounted });
    const r = await revertCustomerDiscountInTx(tx as unknown as Tx, "o1", { reason: "charge_failed" });
    expect(r).toEqual({ reverted: true, billingCustomerId: "cust-1", discountPct: 20, discountCents: 20_000 });
    expect(tx.order.update).toHaveBeenCalledWith({
      where: { id: "o1" },
      data: {
        discountPct: null,
        discountCents: 0,
        discountBillingCustomerId: null,
        discountAppliedAt: null,
        totalCents: 100_000,
      },
    });
    expect(tx.auditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        restaurantId: "r1",
        kind: "order.customer_discount_reverted",
        targetId: "o1",
        actorRole: "system",
        diff: { reason: "charge_failed", billingCustomerId: "cust-1", discountPct: 20, discountCents: 20_000 },
      }),
    });
  });

  it("es idempotente: sin descuento de cliente no escribe nada (segunda llamada)", async () => {
    tx.order.findUnique.mockResolvedValue({ ...discounted, discountPct: null, discountCents: 0, discountBillingCustomerId: null });
    expect(await revertCustomerDiscountInTx(tx as unknown as Tx, "o1", { reason: "checkout_abandoned" }))
      .toEqual({ reverted: false, reason: "no_customer_discount" });
    expect(tx.order.update).not.toHaveBeenCalled();
    expect(tx.auditEvent.create).not.toHaveBeenCalled();
  });

  it("NUNCA toca el descuento del comensal (sin origen de cliente)", async () => {
    tx.order.findUnique.mockResolvedValue({ ...discounted, discountBillingCustomerId: null });
    const r = await revertCustomerDiscountInTx(tx as unknown as Tx, "o1", { reason: "charge_failed" });
    expect(r).toEqual({ reverted: false, reason: "no_customer_discount" });
    expect(tx.order.update).not.toHaveBeenCalled();
  });

  it("con pagos aprobados o pendientes (cobro parcial / mixto) no revierte", async () => {
    tx.order.findUnique.mockResolvedValue({ ...discounted });
    tx.payment.count.mockResolvedValue(1);
    expect(await revertCustomerDiscountInTx(tx as unknown as Tx, "o1", { reason: "charge_failed" }))
      .toEqual({ reverted: false, reason: "not_applicable" });
    expect(tx.payment.count).toHaveBeenCalledWith({ where: { orderId: "o1", status: { in: ["approved", "pending"] } } });
    expect(tx.order.update).not.toHaveBeenCalled();
  });

  it("cuenta ya facturada: el descuento quedó en la factura", async () => {
    tx.order.findUnique.mockResolvedValue({ ...discounted });
    tx.simpleInvoice.count.mockResolvedValue(1);
    expect((await revertCustomerDiscountInTx(tx as unknown as Tx, "o1", { reason: "checkout_abandoned" })).reverted).toBe(false);
    expect(tx.order.update).not.toHaveBeenCalled();
  });

  it("cuenta pagada, en cobro, cancelada, factura manual o de otro comercio: no aplica", async () => {
    for (const order of [
      { ...discounted, status: "paid" },
      { ...discounted, status: "paying" },
      { ...discounted, status: "cancelled" },
      { ...discounted, table: { kind: "manual" } },
    ]) {
      tx.order.findUnique.mockResolvedValue(order);
      expect(await revertCustomerDiscountInTx(tx as unknown as Tx, "o1", { reason: "charge_failed" }))
        .toEqual({ reverted: false, reason: "not_applicable" });
    }
    tx.order.findUnique.mockResolvedValue({ ...discounted });
    expect(await revertCustomerDiscountInTx(tx as unknown as Tx, "o1", { reason: "checkout_abandoned", restaurantId: "otro" }))
      .toEqual({ reverted: false, reason: "not_applicable" });
    expect(tx.order.update).not.toHaveBeenCalled();
  });

  it("abandono desde el cobro: anota quién salió de la pantalla", async () => {
    tx.order.findUnique.mockResolvedValue({ ...discounted });
    await revertCustomerDiscountInTx(tx as unknown as Tx, "o1", {
      reason: "checkout_abandoned",
      restaurantId: "r1",
      actor: { userId: "u1", email: "mesero@example.com", role: "mesero" },
    });
    expect(tx.auditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ actorUserId: "u1", actorRole: "mesero", diff: expect.objectContaining({ reason: "checkout_abandoned" }) }),
    });
  });
});
