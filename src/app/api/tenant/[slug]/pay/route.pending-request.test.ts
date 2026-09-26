import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePaymentsDb } from "@/test/fakePaymentsDb";

/**
 * Regresión del caso de Son y Melona (2026-09-25, mesa 3, orden
 * cmuha8f5w02hfg2u9md57rczo): el comensal eligió "datáfono del comercio"
 * desde el QR — Payment `external_terminal` PENDIENTE por el total
 * (698.170 = 634.700 + 63.470 de propina). El administrador intentó cobrar la
 * cuenta cuatro veces y el trigger `mesapay_reserve_payment` rechazó cada
 * INSERT (`amount_exceeds_outstanding`), que la pantalla mostraba como
 * "operation_conflict".
 *
 * La prueba corre la ruta REAL con `secureApi` real y una base en memoria
 * que reproduce el trigger (src/test/fakePaymentsDb.ts): lo que se verifica
 * es el efecto sobre los pagos y la orden, no qué funciones se llamaron.
 */

const h = vi.hoisted(() => ({
  fake: null as unknown as ReturnType<typeof import("@/test/fakePaymentsDb").createFakePaymentsDb>,
  session: null as null | { user: { id: string; role: string } },
  publish: vi.fn(),
}));

const TENANT = {
  id: "rest-1",
  slug: "sonymelona",
  name: "Son y Melona",
  adminOnlyCharge: false,
  suspended: false,
  enabledPaymentMethods: ["cash", "external_terminal", "kushki_pse"],
};

vi.mock("@/lib/db", () => ({
  db: {
    restaurant: { findUnique: vi.fn(async () => TENANT) },
    order: {
      findFirst: (a: never) => h.fake.tx.order.findFirst(a),
      findUnique: (a: never) => h.fake.tx.order.findUnique(a),
    },
    payment: {
      findUnique: (a: never) => h.fake.tx.payment.findUnique(a),
      findMany: (a: never) => h.fake.tx.payment.findMany(a),
    },
    table: { findUnique: vi.fn(async () => null) },
    $transaction: (cb: never) => h.fake.$transaction(cb),
  },
}));
vi.mock("@/auth", () => ({ auth: async () => h.session }));
vi.mock("@/lib/activeRestaurant", () => ({
  getActiveContext: async () => (h.session ? { restaurantId: "rest-1", session: h.session } : null),
}));
vi.mock("@/lib/rateLimit", () => ({ rateLimit: async () => true }));
vi.mock("@/lib/guestAccess", () => ({ canAccessOrder: async () => true, canAccessTable: async () => true }));
vi.mock("@/lib/orderLock", () => ({ lockOrder: async () => {} }));
vi.mock("@/lib/waiterCommissionsSeal", () => ({ sealOrderCommission: async () => {} }));
vi.mock("@/lib/events", () => ({ publishOrderEvent: h.publish }));
vi.mock("@/lib/mailer", () => ({ welcomeIfFirstTime: async () => {} }));
vi.mock("@/lib/prepaidRounds", () => ({ activateOpenRounds: async () => [] }));
vi.mock("@/lib/kds/autoFireTickets", () => ({ notifyAutoFiredTickets: async () => {} }));
vi.mock("@/lib/push", () => ({ sendPushToMeserosForTable: async () => {} }));
vi.mock("@/lib/meseroShift", () => ({ meseroNeedsShiftToCharge: async () => false }));
vi.mock("@/lib/invoiceOnPaid", () => ({ issueInvoiceOnPaid: async () => ({ status: "skipped" }) }));
vi.mock("@/lib/billRequest", () => ({ announceBillRequestedOnPay: async () => {} }));

import { POST } from "./route";

const ORDER_ID = "cmuha8f5w02hfg2u9md57rczo";
// Montos del caso, en centavos.
const SUBTOTAL = 63_470_000;
const TIP = 6_347_000;
const TOTAL = SUBTOTAL + TIP; // 69.817.000 = $698.170

function seed(payments: Parameters<typeof createFakePaymentsDb>[0]["payments"]) {
  h.fake = createFakePaymentsDb({
    order: { id: ORDER_ID, status: "paying", subtotalCents: SUBTOTAL, tableId: "table-3" },
    payments,
  });
}

async function pay(body: Record<string, unknown>) {
  const res = await POST(
    new Request(`http://localhost/api/tenant/${TENANT.slug}/pay`, {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ orderId: ORDER_ID, ...body }),
    }),
    { params: Promise.resolve({ slug: TENANT.slug }) },
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const ADMIN = { user: { id: "admin-1", role: "operator" } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DATABASE_URL", "postgresql://u:p@localhost:5432/test");
  h.session = null;
});

describe("cobro del staff con una solicitud del comensal pendiente", () => {
  it("la base simulada reproduce el incidente: con la solicitud pendiente, el INSERT del cobro rebota", async () => {
    seed([{ id: "req-datafono", method: "external_terminal", status: "pending", amountCents: TOTAL, tipCents: TIP }]);
    await expect(
      h.fake.tx.payment.create({ data: { orderId: ORDER_ID, method: "cash", status: "approved", amountCents: TOTAL, tipCents: TIP } }),
    ).rejects.toThrow(/amount_exceeds_outstanding/);
  });

  it("datáfono del comercio pendiente por el total + el admin cobra en efectivo: la solicitud queda declined, el cobro approved y la orden paid", async () => {
    seed([{ id: "req-datafono", method: "external_terminal", status: "pending", amountCents: TOTAL, tipCents: TIP }]);
    h.session = ADMIN;

    const { status, json } = await pay({
      method: "cash",
      amountCents: TOTAL,
      tipCents: TIP,
      cashTenderCents: 70_000_000,
      changeGivenCents: 183_000,
      settleNow: true,
    });

    expect(status).toBe(200);
    expect(json).toMatchObject({ paid: true, pending: false });
    expect(h.fake.payment("req-datafono")?.status).toBe("declined");
    const cash = h.fake.state.payments.find((p) => p.method === "cash");
    expect(cash).toMatchObject({
      status: "approved",
      amountCents: TOTAL,
      tipCents: TIP,
      collectedByUserId: "admin-1",
    });
    expect(cash?.settledAt).toBeInstanceOf(Date);
    expect(h.fake.order()).toMatchObject({ status: "paid", tipCents: TIP, totalCents: TOTAL });
    expect(h.fake.order().paidAt).toBeInstanceOf(Date);
    expect(h.publish).toHaveBeenCalledWith("rest-1", { type: "order.paid", orderId: ORDER_ID });
  });

  it("también reemplaza el «voy a pagar en efectivo» del comensal (como antes)", async () => {
    seed([{ id: "req-cash", method: "cash", status: "pending", amountCents: TOTAL, tipCents: TIP }]);
    h.session = ADMIN;

    const { status, json } = await pay({ method: "cash", amountCents: TOTAL, tipCents: TIP, settleNow: true });

    expect(status).toBe(200);
    expect(json.paid).toBe(true);
    expect(h.fake.payment("req-cash")?.status).toBe("declined");
  });

  it("un pago en línea en curso (PSE) que no deja cobrar → 409 pending_payment_in_flight con qué pago es, y no se toca nada", async () => {
    // Medio pagándose por PSE y el otro medio pedido en efectivo por el comensal.
    const half = SUBTOTAL / 2;
    seed([
      { id: "pse", method: "kushki_pse", status: "pending", amountCents: half, tipCents: 0 },
      { id: "req-cash", method: "cash", status: "pending", amountCents: half, tipCents: 0 },
    ]);
    h.session = ADMIN;

    const { status, json } = await pay({ method: "cash", amountCents: TOTAL, tipCents: TIP, settleNow: true });

    expect(status).toBe(409);
    expect(json).toMatchObject({
      error: "pending_payment_in_flight",
      pending: { paymentId: "pse", method: "kushki_pse", amountCents: half, tipCents: 0 },
    });
    // La transacción se revirtió entera: el PSE sigue en vuelo, la solicitud
    // del comensal sigue en pie y no nació ningún cobro.
    expect(h.fake.payment("pse")?.status).toBe("pending");
    expect(h.fake.payment("req-cash")?.status).toBe("pending");
    expect(h.fake.state.payments).toHaveLength(2);
    expect(h.fake.order().status).toBe("paying");
  });

  it("un PSE en curso por una parte no impide cobrar el resto: el PSE queda en vuelo y la solicitud se reemplaza", async () => {
    const half = SUBTOTAL / 2;
    seed([
      { id: "pse", method: "kushki_pse", status: "pending", amountCents: half, tipCents: 0 },
      { id: "req-datafono", method: "external_terminal", status: "pending", amountCents: half, tipCents: 0 },
    ]);
    h.session = ADMIN;

    const { status, json } = await pay({ method: "cash", amountCents: half, tipCents: 0, settleNow: true });

    expect(status).toBe(200);
    expect(json.paid).toBe(false); // falta que el banco confirme el PSE
    expect(h.fake.payment("pse")?.status).toBe("pending");
    expect(h.fake.payment("req-datafono")?.status).toBe("declined");
  });

  it("el comensal (sin sesión) NO reemplaza la solicitud de otro: su pedido de efectivo sigue chocando como antes", async () => {
    seed([{ id: "req-datafono", method: "external_terminal", status: "pending", amountCents: TOTAL, tipCents: TIP }]);

    const { status, json } = await pay({ method: "cash", amountCents: TOTAL, tipCents: TIP });

    expect(status).toBe(409);
    expect(json.error).toBe("operation_conflict");
    expect(h.fake.payment("req-datafono")?.status).toBe("pending");
  });
});
