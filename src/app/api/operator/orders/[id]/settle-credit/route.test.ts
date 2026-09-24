// Cobro a crédito: guardias (rol, turno del mesero, crédito deshabilitado,
// tope), el pago approved que deja y el descuento del cliente aplicado antes
// de calcular lo pendiente.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => {
  const order = {
    restaurantId: "r1",
    status: "open",
    subtotalCents: 100_000,
    taxCents: 0,
    tipCents: 0,
    discountPct: null as number | null,
    discountCents: 0,
    paidAt: null,
  };
  const tx = {
    payment: {
      updateMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => [] as { amountCents: number; tipCents: number }[]),
      count: vi.fn(async () => 0),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: "pay-credit", ...args.data })),
    },
    order: {
      findUnique: vi.fn(async () => ({ ...order })),
      update: vi.fn(async (args: { data: Partial<typeof order> }) => Object.assign(order, args.data)),
    },
    $queryRaw: vi.fn(async () => []),
  };
  return {
    order,
    tx,
    auth: vi.fn(),
    active: vi.fn(),
    orderFindUnique: vi.fn(),
    customerFindFirst: vi.fn(),
    summary: vi.fn(),
    recompute: vi.fn(),
    issueInvoice: vi.fn(async () => ({ status: "skipped" })),
    chargeBlocked: vi.fn(async () => false),
    meseroNeedsShift: vi.fn(async () => false),
    publish: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/activeRestaurant", () => ({ getActiveRestaurantId: m.active }));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/lib/orderLock", () => ({ lockOrder: vi.fn(async () => {}) }));
vi.mock("@/lib/events", () => ({ publishOrderEvent: m.publish }));
vi.mock("@/lib/mailer", () => ({ welcomeIfFirstTime: vi.fn(async () => {}) }));
vi.mock("@/lib/prepaidRounds", () => ({ activateOpenRounds: vi.fn(async () => []) }));
vi.mock("@/lib/kds/autoFireTickets", () => ({ notifyAutoFiredTickets: vi.fn(async () => {}) }));
vi.mock("@/lib/invoiceOnPaid", () => ({ issueInvoiceOnPaid: m.issueInvoice }));
vi.mock("@/lib/meseroShift", () => ({ meseroNeedsShiftToCharge: m.meseroNeedsShift }));
vi.mock("@/lib/chargeGuard", () => ({
  isChargeBlocked: m.chargeBlocked,
  chargeBlockedResponse: () => Response.json({ error: "charge_admin_only" }, { status: 403 }),
}));
vi.mock("@/lib/orderTotals", () => ({
  // Misma aritmética que la real, sin sus dependencias de servidor.
  computeOrderTotals: (subtotal: number, claims: { amountCents: number; tipCents: number }[], tax = 0, discount = 0) => {
    const chargeable = Math.max(0, subtotal + tax - discount);
    const paid = claims.reduce((s, c) => s + c.amountCents, 0);
    const tips = claims.reduce((s, c) => s + c.tipCents, 0);
    const food = paid - tips;
    return { paidSumCents: paid, tipsTotalCents: tips, foodPaidCents: food, fullyPaid: food >= chargeable, outstandingCents: Math.max(0, chargeable - food) };
  },
  recomputeOrderTotalsInTx: m.recompute,
}));
vi.mock("@/lib/customerCredit", async (orig) => ({
  ...(await orig<typeof import("@/lib/customerCredit")>()),
  loadCustomerCreditSummary: m.summary,
}));
vi.mock("@/lib/db", () => ({
  db: {
    order: { findUnique: m.orderFindUnique },
    billingCustomer: { findFirst: m.customerFindFirst },
    $transaction: async (fn: (tx: typeof m.tx) => unknown) => fn(m.tx),
  },
}));

import { POST } from "./route";

const call = (body: unknown = { billingCustomerId: "cust-1" }) =>
  POST(
    new Request("http://localhost/api/operator/orders/order-1/settle-credit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "order-1" }) },
  );

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(m.order, { status: "open", subtotalCents: 100_000, taxCents: 0, tipCents: 0, discountPct: null, discountCents: 0 });
  m.auth.mockResolvedValue({ user: { id: "user-1", role: "operator" } });
  m.active.mockResolvedValue("r1");
  m.orderFindUnique.mockResolvedValue({ id: "order-1", restaurantId: "r1", status: "open", dinerId: null, locale: "es" });
  m.customerFindFirst.mockResolvedValue({ id: "cust-1", creditEnabled: true, discountEnabled: false, discountBps: 0 });
  m.summary.mockResolvedValue({
    customer: { id: "cust-1", creditEnabled: true, creditLimitCents: null, creditTermsDays: 30 },
    charges: [],
    payments: [],
    debtCents: 0,
    fifo: { charges: [], allocations: [], unappliedCents: 0 },
  });
  m.recompute.mockResolvedValue({ fullyPaid: true, outstandingCents: 0, paidSumCents: 100_000, tipsTotalCents: 0, foodPaidCents: 100_000 });
  // clearAllMocks no borra las implementaciones: la cuenta arranca sin pagos.
  m.tx.payment.findMany.mockResolvedValue([]);
  m.tx.payment.count.mockResolvedValue(0);
  m.chargeBlocked.mockResolvedValue(false);
  m.meseroNeedsShift.mockResolvedValue(false);
});

describe("guardias", () => {
  it("rechaza roles sin permiso de cobro", async () => {
    m.auth.mockResolvedValue({ user: { id: "k", role: "kitchen" } });
    expect((await call()).status).toBe(401);
    expect(m.tx.payment.create).not.toHaveBeenCalled();
  });
  it("una cuenta de otro comercio es 403", async () => {
    m.active.mockResolvedValue("otro");
    expect((await call()).status).toBe(403);
  });
  it("mesero sin turno propio (by_waiter) no cobra", async () => {
    m.auth.mockResolvedValue({ user: { id: "w", role: "mesero" } });
    m.meseroNeedsShift.mockResolvedValue(true);
    const res = await call();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "mesero_no_shift" });
  });
  it("cliente sin crédito habilitado → 409 credit_disabled sin abrir transacción", async () => {
    m.customerFindFirst.mockResolvedValue({ id: "cust-1", creditEnabled: false, discountEnabled: false, discountBps: 0 });
    const res = await call();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "credit_disabled" });
    expect(m.tx.payment.create).not.toHaveBeenCalled();
  });
  it("cliente de otro comercio → 404", async () => {
    m.customerFindFirst.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
  });
});

describe("tope de crédito", () => {
  it("deuda + cuenta por encima del tope → 409 con lo disponible, sin pago", async () => {
    m.summary.mockResolvedValue({
      customer: { id: "cust-1", creditEnabled: true, creditLimitCents: 150_000, creditTermsDays: 30 },
      charges: [],
      payments: [],
      debtCents: 80_000,
      fifo: { charges: [], allocations: [], unappliedCents: 0 },
    });
    const res = await call();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "credit_limit_exceeded", debtCents: 80_000, availableCents: 70_000 });
    expect(m.tx.payment.create).not.toHaveBeenCalled();
    expect(m.recompute).not.toHaveBeenCalled();
  });
});

describe("cobro", () => {
  it("crea el pago approved por todo lo pendiente + propina, recalcula y emite la factura", async () => {
    const res = await call({ billingCustomerId: "cust-1", tipCents: 10_000 });
    expect(res.status).toBe(200);
    expect(m.tx.payment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: "order-1",
        method: "customer_credit",
        status: "approved",
        amountCents: 110_000,
        tipCents: 10_000,
        billingCustomerId: "cust-1",
        collectedByUserId: "user-1",
        settledAt: expect.any(Date),
      }),
    });
    expect(m.recompute).toHaveBeenCalledWith(m.tx, "order-1");
    expect(m.issueInvoice).toHaveBeenCalledWith({ tenantId: "r1", orderId: "order-1" });
    expect(m.publish).toHaveBeenCalledWith("r1", { type: "order.paid", orderId: "order-1" });
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, paid: true, paymentId: "pay-credit", amountCents: 110_000, debtAfterCents: 110_000 });
    expect(body.discount).toMatchObject({ applied: false, reason: "no_discount" });
  });

  it("barre el efectivo pendiente del comensal y descuenta lo ya aprobado", async () => {
    m.tx.payment.findMany.mockResolvedValue([{ amountCents: 40_000, tipCents: 0 }]);
    await call();
    expect(m.tx.payment.updateMany).toHaveBeenCalledWith({
      where: { orderId: "order-1", method: { in: ["cash", "demo_cash"] }, status: "pending" },
      data: { status: "declined" },
    });
    expect(m.tx.payment.create).toHaveBeenCalledWith({ data: expect.objectContaining({ amountCents: 60_000 }) });
  });

  it("con nada pendiente responde nothing_outstanding", async () => {
    m.tx.payment.findMany.mockResolvedValue([{ amountCents: 100_000, tipCents: 0 }]);
    const res = await call();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "nothing_outstanding" });
  });

  it("cliente con descuento: lo aplica a la cuenta y cobra a crédito el neto", async () => {
    m.customerFindFirst.mockResolvedValue({ id: "cust-1", creditEnabled: true, discountEnabled: true, discountBps: 1000 });
    const res = await call();
    expect(res.status).toBe(200);
    expect(m.tx.order.update).toHaveBeenCalledWith({
      where: { id: "order-1" },
      data: { discountPct: 10, discountCents: 10_000, totalCents: 90_000 },
    });
    expect(m.tx.payment.create).toHaveBeenCalledWith({ data: expect.objectContaining({ amountCents: 90_000, tipCents: 0 }) });
    const body = await res.json();
    expect(body.amountCents).toBe(90_000);
    expect(body.discount).toMatchObject({ applied: true, changed: true, discountPct: 10, discountCents: 10_000 });
  });

  it("con un descuento manual mayor ya aplicado, lo conserva y cobra ese neto", async () => {
    Object.assign(m.order, { discountPct: 20, discountCents: 20_000 });
    m.customerFindFirst.mockResolvedValue({ id: "cust-1", creditEnabled: true, discountEnabled: true, discountBps: 1000 });
    const res = await call();
    expect(res.status).toBe(200);
    expect(m.tx.order.update).not.toHaveBeenCalled();
    expect(m.tx.payment.create).toHaveBeenCalledWith({ data: expect.objectContaining({ amountCents: 80_000 }) });
    expect((await res.json()).discount).toMatchObject({ applied: false, reason: "existing_greater" });
  });
});
