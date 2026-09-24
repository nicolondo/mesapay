// Confirmar un cobro en efectivo pedido desde la mesa: el pago queda
// approved como `cash` (el efectivo real), también si el pending se creó
// como `demo_cash` antes de que existiera `cash`. Lo que no es efectivo no
// se puede cerrar por acá.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => {
  const tx = {
    payment: {
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: "pay-1", ...args.data })),
    },
  };
  return {
    tx,
    auth: vi.fn(),
    active: vi.fn(),
    paymentFindUnique: vi.fn(),
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
vi.mock("@/lib/orderTotals", () => ({ recomputeOrderTotalsInTx: m.recompute }));
vi.mock("@/lib/db", () => ({
  db: {
    payment: { findUnique: m.paymentFindUnique },
    $transaction: async (fn: (tx: typeof m.tx) => unknown) => fn(m.tx),
  },
}));

import { POST } from "./route";

function pendingPayment(method: string) {
  return {
    id: "pay-1",
    orderId: "order-1",
    method,
    status: "pending",
    amountCents: 43_000_00,
    tipCents: 0,
    collectedByUserId: null,
    order: { id: "order-1", restaurantId: "r1", status: "open", dinerId: null, locale: "es" },
  };
}

const call = (body: unknown = { cashReceivedCents: 50_000_00, changeGivenCents: 7_000_00 }) =>
  POST(
    new Request("http://localhost/api/operator/payments/pay-1/settle-cash", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "pay-1" }) },
  );

function updateData(): Record<string, unknown> {
  expect(m.tx.payment.update).toHaveBeenCalledTimes(1);
  return (m.tx.payment.update.mock.calls[0][0] as { data: Record<string, unknown> }).data;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.auth.mockResolvedValue({ user: { id: "mesero-1", role: "mesero" } });
  m.active.mockResolvedValue("r1");
  m.recompute.mockResolvedValue({ fullyPaid: true });
});

describe("POST /api/operator/payments/[id]/settle-cash", () => {
  it("cierra el pending de efectivo como cash, approved y con el mesero como cobrador", async () => {
    m.paymentFindUnique.mockResolvedValue(pendingPayment("cash"));
    m.tx.payment.findUniqueOrThrow.mockResolvedValue(pendingPayment("cash"));

    const res = await call();

    expect(res.status).toBe(200);
    expect(updateData()).toEqual(
      expect.objectContaining({
        method: "cash",
        status: "approved",
        amountCents: 43_000_00,
        collectedByUserId: "mesero-1",
      }),
    );
  });

  it("un pending viejo grabado como demo_cash se acepta y se cierra ya como cash", async () => {
    m.paymentFindUnique.mockResolvedValue(pendingPayment("demo_cash"));
    m.tx.payment.findUniqueOrThrow.mockResolvedValue(pendingPayment("demo_cash"));

    const res = await call();

    expect(res.status).toBe(200);
    expect(updateData()).toEqual(expect.objectContaining({ method: "cash", status: "approved" }));
  });

  it("lo que sobra del recibido (sin devolver) queda como propina en el mismo pago", async () => {
    m.paymentFindUnique.mockResolvedValue(pendingPayment("cash"));
    m.tx.payment.findUniqueOrThrow.mockResolvedValue(pendingPayment("cash"));

    const res = await call({ cashReceivedCents: 50_000_00, changeGivenCents: 5_000_00 });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(expect.objectContaining({ extraTipCents: 2_000_00 }));
    expect(updateData()).toEqual(expect.objectContaining({ method: "cash", amountCents: 45_000_00, tipCents: 2_000_00 }));
  });

  it("un pago que no es efectivo no se cierra por acá", async () => {
    m.paymentFindUnique.mockResolvedValue(pendingPayment("kushki_card_terminal"));

    const res = await call();

    expect(res.status).toBe(400);
    expect(m.tx.payment.update).not.toHaveBeenCalled();
  });
});
