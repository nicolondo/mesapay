import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePaymentsDb } from "@/test/fakePaymentsDb";

/**
 * Acreditar el abono de una reserva es un cobro del staff: si el comensal
 * ya pidió pagar la cuenta entera (efectivo, datáfono propio), esa solicitud
 * deja de ser por el monto correcto y se reemplaza; un pago en línea en
 * curso que no deja espacio responde 409 pending_payment_in_flight.
 */

const h = vi.hoisted(() => ({
  fake: null as unknown as ReturnType<typeof import("@/test/fakePaymentsDb").createFakePaymentsDb>,
  reservation: {
    id: "res-1",
    restaurantId: "rest-1",
    status: "seated",
    tableId: "table-3",
    depositStatus: "paid",
    depositCents: 20_000_000,
    depositTxId: "kushki-tx-1",
    appliedOrderId: null as string | null,
  },
}));

const SESSION = { user: { id: "admin-1", role: "operator" } };

vi.mock("@/lib/db", () => ({
  db: {
    restaurant: { findUnique: vi.fn(async () => ({ id: "rest-1", suspended: false })) },
    reservation: { findUnique: vi.fn(async () => ({ ...h.reservation })) },
    order: { findFirst: (a: never) => h.fake.tx.order.findFirst(a) },
    $transaction: (cb: never) => h.fake.$transaction(cb),
  },
}));
vi.mock("@/auth", () => ({ auth: async () => SESSION }));
vi.mock("@/lib/activeRestaurant", () => ({
  getActiveContext: async () => ({ restaurantId: "rest-1", session: SESSION }),
  getActiveRestaurantId: async () => "rest-1",
}));
vi.mock("@/lib/rateLimit", () => ({ rateLimit: async () => true }));
vi.mock("@/lib/orderLock", () => ({ lockOrder: async () => {} }));
vi.mock("@/lib/waiterCommissionsSeal", () => ({ sealOrderCommission: async () => {} }));
vi.mock("@/lib/events", () => ({ publishOrderEvent: vi.fn() }));
vi.mock("@/lib/invoiceOnPaid", () => ({ issueInvoiceOnPaid: async () => ({ status: "skipped" }) }));

import { PATCH } from "./route";

const ORDER_ID = "order-3";
const SUBTOTAL = 63_470_000;

function seed(payments: Parameters<typeof createFakePaymentsDb>[0]["payments"]) {
  h.fake = createFakePaymentsDb({
    order: { id: ORDER_ID, status: "paying", subtotalCents: SUBTOTAL, tableId: "table-3" },
    payments,
    extraTx: {
      reservation: {
        findUniqueOrThrow: async () => ({ ...h.reservation }),
        update: async ({ data }: { data: Record<string, unknown> }) => Object.assign(h.reservation, data),
      },
    },
  });
}

async function applyDeposit() {
  const res = await PATCH(
    new Request("http://localhost/api/operator/reservations/res-1", {
      method: "PATCH",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ action: "apply_deposit" }),
    }),
    { params: Promise.resolve({ id: "res-1" }) },
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "postgresql://u:p@localhost:5432/test");
  Object.assign(h.reservation, { depositStatus: "paid", appliedOrderId: null });
});

describe("apply_deposit con pagos pendientes", () => {
  it("el comensal pidió datáfono del comercio por el total: la solicitud se reemplaza y el abono entra", async () => {
    seed([{ id: "req-datafono", method: "external_terminal", status: "pending", amountCents: SUBTOTAL, tipCents: 0 }]);
    const { status, json } = await applyDeposit();
    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, applied: true });
    expect(h.fake.payment("req-datafono")?.status).toBe("declined");
    expect(h.fake.state.payments.find((p) => p.method === "reservation_deposit")).toMatchObject({
      status: "approved",
      amountCents: 20_000_000,
    });
    expect(h.reservation.depositStatus).toBe("applied");
  });

  it("un PSE en curso por el total: 409 pending_payment_in_flight y el abono sigue sin acreditar", async () => {
    seed([{ id: "pse", method: "kushki_pse", status: "pending", amountCents: SUBTOTAL, tipCents: 0 }]);
    const { status, json } = await applyDeposit();
    expect(status).toBe(409);
    expect(json).toMatchObject({ error: "pending_payment_in_flight", pending: { paymentId: "pse", method: "kushki_pse" } });
    expect(h.fake.state.payments).toHaveLength(1);
    expect(h.reservation.depositStatus).toBe("paid");
  });
});
