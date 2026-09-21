import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `recomputeOrderTotalsInTx` es el ÚNICO punto por donde una cuenta pasa a
 * `paid`; acá se prueba que en ese instante (y sólo en ese) dispara el
 * sellado de la comisión, dentro de la misma tx, y que el sellado jamás
 * bloquea el cobro.
 */
const m = vi.hoisted(() => ({
  lockOrder: vi.fn(async () => undefined),
  seal: vi.fn(async () => ({ sealed: true })),
  orderFindUnique: vi.fn(),
  orderUpdate: vi.fn(async () => undefined),
  paymentFindMany: vi.fn(),
}));

vi.mock("./db", () => ({ db: {} }));
vi.mock("./orderLock", () => ({ lockOrder: m.lockOrder }));
vi.mock("./waiterCommissionsSeal", () => ({ sealOrderCommission: m.seal }));

import { computeOrderTotals, recomputeOrderTotalsInTx } from "./orderTotals";

const tx = {
  order: { findUnique: m.orderFindUnique, update: m.orderUpdate },
  payment: { findMany: m.paymentFindMany },
} as unknown as Parameters<typeof recomputeOrderTotalsInTx>[0];

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  m.orderFindUnique.mockResolvedValue({
    subtotalCents: 100_000,
    taxCents: 0,
    discountCents: 0,
    paidAt: null,
  });
});

describe("recomputeOrderTotalsInTx + sellado de comisión", () => {
  it("cuando la cuenta queda saldada, sella la comisión con la MISMA tx", async () => {
    m.paymentFindMany.mockResolvedValue([{ amountCents: 110_000, tipCents: 10_000 }]);
    const totals = await recomputeOrderTotalsInTx(tx, "o1");
    expect(totals.fullyPaid).toBe(true);
    expect(m.orderUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "paid" }) }),
    );
    expect(m.seal).toHaveBeenCalledTimes(1);
    expect(m.seal).toHaveBeenCalledWith(tx, "o1");
    // El sello va DESPUÉS de marcar la cuenta pagada (lee status === "paid").
    expect(m.orderUpdate.mock.invocationCallOrder[0]).toBeLessThan(m.seal.mock.invocationCallOrder[0]);
  });

  it("con un pago parcial no sella nada", async () => {
    m.paymentFindMany.mockResolvedValue([{ amountCents: 40_000, tipCents: 0 }]);
    const totals = await recomputeOrderTotalsInTx(tx, "o1");
    expect(totals.fullyPaid).toBe(false);
    expect(m.seal).not.toHaveBeenCalled();
  });

  it("si el sellado explota, el cobro sigue (el recálculo devuelve igual)", async () => {
    m.paymentFindMany.mockResolvedValue([{ amountCents: 100_000, tipCents: 0 }]);
    m.seal.mockRejectedValueOnce(new Error("boom"));
    await expect(recomputeOrderTotalsInTx(tx, "o1")).resolves.toMatchObject({ fullyPaid: true });
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("[comisiones]"),
      expect.objectContaining({ orderId: "o1" }),
    );
  });
});

describe("computeOrderTotals (sin cambios: la base del sello es el subtotal, no el total)", () => {
  it("la propina no cuenta para saldar la comida y el descuento sí baja lo cobrable", () => {
    const t = computeOrderTotals(100_000, [{ amountCents: 95_000, tipCents: 5_000 }], 0, 10_000);
    expect(t.fullyPaid).toBe(true);
    expect(t.foodPaidCents).toBe(90_000);
  });
});
