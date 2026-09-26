import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Redención con la DB mockeada. Lo que se prueba es la DECISIÓN y las
 * escrituras: cuánto se aplica (parcial vs. total), el saldo que queda,
 * los rechazos (vencido, cancelado, ajeno, lote impago, módulo apagado),
 * la idempotencia por (bono, orden) y el Payment que nace sin propina.
 */
const m = vi.hoisted(() => ({
  restaurantFindUnique: vi.fn(),
  voucherFindUnique: vi.fn(),
  voucherUpdateMany: vi.fn(),
  voucherUpdate: vi.fn(),
  orderFindUnique: vi.fn(),
  orderFindFirst: vi.fn(),
  paymentFindMany: vi.fn(),
  paymentFindFirst: vi.fn(),
  paymentUpdateMany: vi.fn(),
  paymentCreate: vi.fn(),
  redemptionFindUnique: vi.fn(),
  redemptionCreate: vi.fn(),
  queryRaw: vi.fn(),
  recompute: vi.fn(),
  activateRounds: vi.fn(),
  publish: vi.fn(),
  invoice: vi.fn(),
  notify: vi.fn(),
}));

const tx = {
  $queryRaw: m.queryRaw,
  order: { findUnique: m.orderFindUnique, findFirst: m.orderFindFirst },
  payment: {
    findMany: m.paymentFindMany,
    findFirst: m.paymentFindFirst,
    updateMany: m.paymentUpdateMany,
    create: m.paymentCreate,
  },
  voucher: { findUnique: m.voucherFindUnique, updateMany: m.voucherUpdateMany, update: m.voucherUpdate },
  voucherRedemption: { findUnique: m.redemptionFindUnique, create: m.redemptionCreate },
};

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    restaurant: { findUnique: m.restaurantFindUnique },
    voucher: { findUnique: m.voucherFindUnique },
    order: { findUnique: m.orderFindUnique, findFirst: m.orderFindFirst },
    payment: { findMany: m.paymentFindMany, findFirst: m.paymentFindFirst },
  },
}));
vi.mock("@/lib/orderLock", () => ({ lockOrder: vi.fn() }));
vi.mock("@/lib/orderTotals", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/orderTotals")>();
  return { computeOrderTotals: actual.computeOrderTotals, recomputeOrderTotalsInTx: m.recompute };
});
vi.mock("@/lib/prepaidRounds", () => ({ activateOpenRounds: m.activateRounds }));
vi.mock("@/lib/events", () => ({ publishOrderEvent: m.publish }));
vi.mock("@/lib/invoiceOnPaid", () => ({ issueInvoiceOnPaid: m.invoice }));
vi.mock("@/lib/kds/autoFireTickets", () => ({ notifyAutoFiredTickets: m.notify }));

import { previewVoucher, redeemVoucher } from "./redeem";
import { PendingPaymentInFlightError } from "@/lib/payments/paymentInFlight";

const VOUCHER = {
  id: "v-1",
  code: "SM7K3Q9X2A",
  status: "active",
  balanceCents: 300_000_00,
  expiresAt: null,
  batch: { mode: "prepaid", status: "paid" },
};

function order(subtotalCents: number, paid: { amountCents: number; tipCents: number }[] = []) {
  m.orderFindUnique.mockResolvedValue({ subtotalCents, taxCents: 0, discountCents: 0, status: "placed" });
  m.orderFindFirst.mockResolvedValue({ id: "order-1", status: "placed" });
  m.paymentFindMany.mockResolvedValue(paid);
}

const redeem = (over: Partial<Parameters<typeof redeemVoucher>[0]> = {}) =>
  redeemVoucher({
    restaurantId: "rest-1",
    code: "sm-7k3q-9x2a",
    orderId: "order-1",
    channel: "diner",
    ...over,
  });

beforeEach(() => {
  vi.resetAllMocks();
  m.restaurantFindUnique.mockResolvedValue({ enabledModules: ["vouchers"] });
  m.voucherFindUnique.mockResolvedValue(VOUCHER);
  m.redemptionFindUnique.mockResolvedValue(null);
  m.voucherUpdateMany.mockResolvedValue({ count: 1 });
  m.paymentCreate.mockResolvedValue({ id: "pay-1" });
  m.redemptionCreate.mockResolvedValue({ id: "red-1" });
  m.activateRounds.mockResolvedValue([]);
  m.queryRaw.mockResolvedValue([]);
  m.paymentFindFirst.mockResolvedValue(null);
  m.paymentUpdateMany.mockResolvedValue({ count: 0 });
  order(450_000_00);
  m.recompute.mockResolvedValue({ fullyPaid: false, outstandingCents: 150_000_00 });
});

describe("cuánto se aplica", () => {
  it("cuenta más grande que el bono: se aplica todo el saldo, el bono queda agotado y falta la diferencia", async () => {
    const r = await redeem();
    expect(r).toMatchObject({
      ok: true,
      code: "SM-7K3Q-9X2A",
      amountCents: 300_000_00,
      balanceAfterCents: 0,
      outstandingAfterCents: 150_000_00,
      fullyPaid: false,
      alreadyApplied: false,
    });
    expect(m.voucherUpdateMany).toHaveBeenCalledWith({
      where: { id: "v-1", status: "active", balanceCents: { gte: 300_000_00 } },
      data: { balanceCents: { decrement: 300_000_00 } },
    });
    expect(m.voucherUpdate).toHaveBeenCalledWith({ where: { id: "v-1" }, data: { status: "exhausted" } });
    expect(m.paymentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: "order-1",
        method: "voucher",
        status: "approved",
        amountCents: 300_000_00,
        tipCents: 0,
        providerRef: "SM-7K3Q-9X2A",
        collectedByUserId: null,
      }),
    });
    expect(m.redemptionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ voucherId: "v-1", orderId: "order-1", paymentId: "pay-1", amountCents: 300_000_00, channel: "diner" }),
    });
    expect(m.publish).toHaveBeenCalledWith("rest-1", { type: "order.updated", orderId: "order-1" });
    expect(m.invoice).not.toHaveBeenCalled();
  });

  it("cuenta más chica: se aplica lo pendiente, la cuenta queda pagada y el saldo queda para la próxima", async () => {
    order(120_000_00);
    m.recompute.mockResolvedValue({ fullyPaid: true, outstandingCents: 0 });
    const r = await redeem({ channel: "staff", userId: "user-9" });
    expect(r).toMatchObject({ ok: true, amountCents: 120_000_00, balanceAfterCents: 180_000_00, fullyPaid: true });
    expect(m.voucherUpdate).not.toHaveBeenCalled(); // sigue activo con saldo
    expect(m.paymentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ amountCents: 120_000_00, collectedByUserId: "user-9" }),
    });
    expect(m.redemptionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ channel: "staff", redeemedByUserId: "user-9" }),
    });
    expect(m.activateRounds).toHaveBeenCalled();
    expect(m.publish).toHaveBeenCalledWith("rest-1", { type: "order.paid", orderId: "order-1" });
    expect(m.invoice).toHaveBeenCalledWith({ tenantId: "rest-1", orderId: "order-1" });
  });

  it("lo pendiente descuenta los pagos ya hechos (aprobados y pendientes), nunca la propina", async () => {
    order(450_000_00, [{ amountCents: 220_000_00, tipCents: 20_000_00 }]);
    // pendiente = 450.000 − (220.000 − 20.000) = 250.000 < saldo 300.000
    const r = await redeem();
    expect(r).toMatchObject({ ok: true, amountCents: 250_000_00, balanceAfterCents: 50_000_00 });
  });

  it("el preview dice lo mismo que la redención, sin escribir nada", async () => {
    const p = await previewVoucher({ restaurantId: "rest-1", code: "SM-7K3Q-9X2A", orderId: "order-1" });
    expect(p).toEqual({
      ok: true,
      code: "SM-7K3Q-9X2A",
      balanceCents: 300_000_00,
      applicableCents: 300_000_00,
      outstandingCents: 450_000_00,
    });
    expect(m.paymentCreate).not.toHaveBeenCalled();
    expect(m.voucherUpdateMany).not.toHaveBeenCalled();
  });
});

describe("rechazos", () => {
  it.each([
    ["vencido", { ...VOUCHER, expiresAt: new Date("2020-01-01") }, "expired"],
    ["cancelado", { ...VOUCHER, status: "cancelled" }, "cancelled"],
    ["agotado", { ...VOUCHER, balanceCents: 0 }, "exhausted"],
    ["lote prepago sin pagar", { ...VOUCHER, batch: { mode: "prepaid", status: "issued" } }, "batch_unpaid"],
    ["lote cancelado", { ...VOUCHER, batch: { mode: "credit", status: "cancelled" } }, "batch_cancelled"],
  ])("%s → %s, sin escribir", async (_label, voucher, error) => {
    m.voucherFindUnique.mockResolvedValue(voucher);
    expect(await redeem()).toEqual({ ok: false, error });
    expect(m.paymentCreate).not.toHaveBeenCalled();
    expect(m.voucherUpdateMany).not.toHaveBeenCalled();
  });

  it("el bono de otro comercio no existe: se busca por (restaurantId, code)", async () => {
    m.voucherFindUnique.mockResolvedValue(null);
    expect(await redeem()).toEqual({ ok: false, error: "not_found" });
    expect(m.voucherFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { restaurantId_code: { restaurantId: "rest-1", code: "SM7K3Q9X2A" } } }),
    );
  });

  it("basura no llega a la base", async () => {
    expect(await redeem({ code: "hola" })).toEqual({ ok: false, error: "not_found" });
    expect(m.voucherFindUnique).not.toHaveBeenCalled();
  });

  it("con el módulo apagado responde module_disabled aunque el código exista", async () => {
    m.restaurantFindUnique.mockResolvedValue({ enabledModules: ["einvoicing"] });
    expect(await redeem()).toEqual({ ok: false, error: "module_disabled" });
    expect(m.voucherFindUnique).not.toHaveBeenCalled();
  });

  it("cuenta cerrada o sin nada pendiente", async () => {
    m.orderFindFirst.mockResolvedValue({ id: "order-1", status: "paid" });
    expect(await redeem()).toEqual({ ok: false, error: "order_closed" });
    order(100_00, [{ amountCents: 100_00, tipCents: 0 }]);
    expect(await redeem()).toEqual({ ok: false, error: "nothing_outstanding" });
    expect(m.paymentCreate).not.toHaveBeenCalled();
  });

  it("carrera: si el updateMany condicionado no pega, no nace ningún pago", async () => {
    m.voucherUpdateMany.mockResolvedValue({ count: 0 });
    expect(await redeem()).toEqual({ ok: false, error: "exhausted" });
    expect(m.paymentCreate).not.toHaveBeenCalled();
    expect(m.redemptionCreate).not.toHaveBeenCalled();
  });
});

describe("idempotencia", () => {
  it("la misma orden con el mismo bono devuelve lo ya aplicado y no escribe", async () => {
    m.redemptionFindUnique.mockResolvedValue({
      paymentId: "pay-1",
      amountCents: 300_000_00,
      voucher: { balanceCents: 0 },
    });
    const r = await redeem();
    expect(r).toMatchObject({ ok: true, paymentId: "pay-1", amountCents: 300_000_00, alreadyApplied: true });
    expect(m.paymentCreate).not.toHaveBeenCalled();
    expect(m.voucherUpdateMany).not.toHaveBeenCalled();
    expect(m.publish).not.toHaveBeenCalled();
  });
});

describe("canal staff: solicitudes del comensal y pagos en línea en curso", () => {
  // La cuenta de 120.000 ya tiene un pendiente del comensal por el total.
  // findMany responde según el where: el staff pregunta por aprobados + en
  // vuelo (OR), el comensal por aprobados + pendientes (status in).
  function withPending(method: string) {
    order(120_000_00);
    const pending = { amountCents: 132_000_00, tipCents: 12_000_00, status: "pending", method };
    const inFlight = !["cash", "demo_cash", "external_terminal"].includes(method);
    m.paymentFindMany.mockImplementation(async ({ where }: { where: { OR?: unknown } }) =>
      where.OR ? (inFlight ? [pending] : []) : [pending],
    );
    m.paymentFindFirst.mockResolvedValue(
      inFlight ? { id: "p-1", method, amountCents: 132_000_00, tipCents: 12_000_00, createdAt: new Date("2026-09-25T19:03:18Z") } : null,
    );
  }

  it("el comensal pidió datáfono del comercio: el bono aplicado por el staff la reemplaza", async () => {
    withPending("external_terminal");
    m.recompute.mockResolvedValue({ fullyPaid: true, outstandingCents: 0 });
    const r = await redeem({ channel: "staff", userId: "user-9" });
    expect(r).toMatchObject({ ok: true, amountCents: 120_000_00, fullyPaid: true });
    expect(m.paymentUpdateMany).toHaveBeenCalledWith({
      where: { orderId: "order-1", method: { in: ["cash", "demo_cash", "external_terminal"] }, status: "pending" },
      data: { status: "declined" },
    });
    // Declinada ANTES del INSERT (si no, el trigger lo rechazaría).
    expect(m.paymentUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(m.paymentCreate.mock.invocationCallOrder[0]);
  });

  it("el comensal redimiendo no reemplaza nada: su solicitud sigue reservando", async () => {
    withPending("external_terminal");
    expect(await redeem()).toEqual({ ok: false, error: "nothing_outstanding" });
    expect(m.paymentUpdateMany).not.toHaveBeenCalled();
  });

  it("un PSE en curso por el total: 409 accionable, sin debitar el bono", async () => {
    withPending("kushki_pse");
    const err = await redeem({ channel: "staff", userId: "user-9" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PendingPaymentInFlightError);
    expect((err as PendingPaymentInFlightError).pending).toMatchObject({ paymentId: "p-1", method: "kushki_pse" });
    expect(m.voucherUpdateMany).not.toHaveBeenCalled();
    expect(m.paymentCreate).not.toHaveBeenCalled();
  });

  it("el preview del staff tampoco cuenta la solicitud del comensal", async () => {
    withPending("cash");
    const p = await previewVoucher({ restaurantId: "rest-1", code: "SM-7K3Q-9X2A", orderId: "order-1", channel: "staff" });
    expect(p).toMatchObject({ ok: true, applicableCents: 120_000_00, outstandingCents: 120_000_00 });
    expect(m.paymentUpdateMany).not.toHaveBeenCalled();
  });
});
