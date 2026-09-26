import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePaymentsDb } from "@/test/fakePaymentsDb";

/**
 * Cobro con datáfono desde el checkout en modo mesero (operador o mesero):
 * `external-terminal-request` (datáfono propio del comercio) y
 * `terminal-request` (Smart POS de Kushki). Con sesión de staff, la
 * solicitud del comensal se reemplaza y un pago en línea en curso responde
 * el 409 accionable; el comensal sigue como antes. Rutas reales con
 * `secureApi` real contra la base en memoria con el trigger de reserva.
 */

const h = vi.hoisted(() => ({
  fake: null as unknown as ReturnType<typeof import("@/test/fakePaymentsDb").createFakePaymentsDb>,
  session: null as null | { user: { id: string; role: string } },
}));

const TENANT = {
  id: "rest-1",
  slug: "sonymelona",
  name: "Son y Melona",
  adminOnlyCharge: false,
  suspended: false,
  enabledPaymentMethods: ["cash", "external_terminal", "kushki_card_terminal", "kushki_pse"],
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
vi.mock("@/lib/events", () => ({ publishOrderEvent: vi.fn() }));
vi.mock("@/lib/push", () => ({ sendPushToMeserosForTable: async () => {} }));
vi.mock("@/lib/billRequest", () => ({ announceBillRequestedOnPay: async () => {} }));

import { POST as EXTERNAL } from "./external-terminal-request/route";
import { POST as KUSHKI } from "./terminal-request/route";

const ORDER_ID = "order-3";
const SUBTOTAL = 63_470_000;
const TIP = 6_347_000;
const TOTAL = SUBTOTAL + TIP;

function seed(payments: Parameters<typeof createFakePaymentsDb>[0]["payments"]) {
  h.fake = createFakePaymentsDb({ order: { id: ORDER_ID, status: "paying", subtotalCents: SUBTOTAL }, payments });
}

async function call(route: typeof EXTERNAL, action: string, body: Record<string, unknown>) {
  const res = await route(
    new Request(`http://localhost/api/tenant/${TENANT.slug}/pay/${action}`, {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ orderId: ORDER_ID, ...body }),
    }),
    { params: Promise.resolve({ slug: TENANT.slug }) },
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const ADMIN = { user: { id: "admin-1", role: "operator" } };
const MESERO = { user: { id: "mesero-1", role: "mesero" } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DATABASE_URL", "postgresql://u:p@localhost:5432/test");
  h.session = null;
});

describe.each([
  ["external-terminal-request", EXTERNAL, "external_terminal"],
  ["terminal-request", KUSHKI, "kushki_card_terminal"],
] as const)("%s con sesión de staff", (action, route, method) => {
  it("el comensal pidió efectivo por el total y el mesero cobra con datáfono (otra propina): la solicitud se reemplaza", async () => {
    seed([{ id: "req-cash", method: "cash", status: "pending", amountCents: SUBTOTAL, tipCents: 0 }]);
    h.session = MESERO;

    const { status, json } = await call(route, action, { amountCents: TOTAL, tipCents: TIP });

    expect(status).toBe(200);
    expect(json.pending).toBe(true);
    expect(h.fake.payment("req-cash")?.status).toBe("declined");
    expect(h.fake.payment(json.paymentId as string)).toMatchObject({
      method,
      status: "pending",
      amountCents: TOTAL,
      tipCents: TIP,
      collectedByUserId: "mesero-1",
    });
  });

  it("un PSE en curso por el total → 409 pending_payment_in_flight y nada cambia", async () => {
    seed([{ id: "pse", method: "kushki_pse", status: "pending", amountCents: TOTAL, tipCents: TIP }]);
    h.session = ADMIN;

    const { status, json } = await call(route, action, { amountCents: TOTAL, tipCents: TIP });

    expect(status).toBe(409);
    expect(json).toMatchObject({ error: "pending_payment_in_flight", pending: { paymentId: "pse", method: "kushki_pse" } });
    expect(h.fake.state.payments).toHaveLength(1);
    expect(h.fake.payment("pse")?.status).toBe("pending");
  });

  it("el comensal (sin sesión) no reemplaza nada: el tope previo lo rechaza como siempre", async () => {
    seed([{ id: "req-cash", method: "cash", status: "pending", amountCents: SUBTOTAL, tipCents: 0 }]);

    const { status, json } = await call(route, action, { amountCents: TOTAL, tipCents: TIP });

    expect(status).toBe(409);
    expect(json.error).toBe("amount_exceeds_outstanding");
    expect(h.fake.payment("req-cash")?.status).toBe("pending");
  });
});

describe("external-terminal-request: el staff reusa la solicitud idéntica del comensal", () => {
  it("mismo monto y propina: devuelve el mismo pendiente para confirmarlo en Salón, sin declinarlo", async () => {
    seed([{ id: "req-datafono", method: "external_terminal", status: "pending", amountCents: TOTAL, tipCents: TIP }]);
    h.session = ADMIN;

    const { status, json } = await call(EXTERNAL, "external-terminal-request", { amountCents: TOTAL, tipCents: TIP });

    expect(status).toBe(200);
    expect(json.paymentId).toBe("req-datafono");
    expect(h.fake.payment("req-datafono")?.status).toBe("pending");
    expect(h.fake.state.payments).toHaveLength(1);
  });
});
