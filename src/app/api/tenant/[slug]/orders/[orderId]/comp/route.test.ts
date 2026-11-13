import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePaymentsDb } from "@/test/fakePaymentsDb";

/**
 * Cortesía (cerrar la cuenta en $0) con pagos pendientes. Es un cierre del
 * staff como cualquier cobro: la solicitud del comensal (efectivo, datáfono
 * propio) queda obsoleta y se declina; un pago en línea en curso impide
 * regalar la cuenta y lo dice (409 pending_payment_in_flight); algo ya
 * cobrado también la impide, sin tocar la solicitud.
 */

const h = vi.hoisted(() => ({
  fake: null as unknown as ReturnType<typeof import("@/test/fakePaymentsDb").createFakePaymentsDb>,
  session: { user: { id: "admin-1", role: "operator", email: "admin@sonymelona.co" } } as null | {
    user: { id: string; role: string; email: string };
  },
  // Factura emitida antes de cobrar y cuánto la cubren las notas crédito.
  invoice: null as null | { id: string; invoiceNumber: number; snapshot: unknown; totalCents: number },
  creditedCents: 0,
}));

const TENANT = {
  id: "rest-1",
  slug: "sonymelona",
  compEnabled: true,
  compLabel: null,
  adminOnlyCharge: false,
  compAllowedRoles: ["operator"],
  suspended: false,
  enabledPaymentMethods: ["cash", "external_terminal"],
};

vi.mock("@/lib/db", () => ({
  db: {
    restaurant: { findUnique: vi.fn(async () => TENANT) },
    order: { findUnique: (a: never) => h.fake.tx.order.findUnique(a) },
    // Sin factura emitida antes de cobrar (la cortesía de siempre), salvo
    // en los casos que la siembran.
    simpleInvoice: { findUnique: async () => h.invoice },
    creditNote: { aggregate: async () => ({ _sum: { totalCents: h.creditedCents } }) },
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
vi.mock("@/lib/events", () => ({ publishOrderEvent: vi.fn() }));
vi.mock("@/lib/prepaidRounds", () => ({ activateOpenRounds: async () => [] }));
vi.mock("@/lib/kds/autoFireTickets", () => ({ notifyAutoFiredTickets: async () => {} }));
vi.mock("@/lib/invoiceOnPaid", () => ({ issueInvoiceOnPaid: async () => ({ status: "skipped" }) }));
vi.mock("@/lib/meseroShift", () => ({ meseroNeedsShiftToCharge: async () => false }));
vi.mock("@/lib/auditLog", () => ({ recordAuditEvent: async () => {} }));

import { POST } from "./route";

const ORDER_ID = "order-3";

function seed(payments: Parameters<typeof createFakePaymentsDb>[0]["payments"]) {
  h.fake = createFakePaymentsDb({
    order: { id: ORDER_ID, status: "paying", subtotalCents: 63_470_000, table: { kind: "standard" } },
    payments,
    extraTx: {
      orderItem: {
        findMany: async () => [{ id: "item-1", qty: 1, priceCentsSnapshot: 63_470_000 }],
        updateMany: async () => ({ count: 1 }),
      },
    },
  });
}

async function comp() {
  const res = await POST(
    new Request(`http://localhost/api/tenant/${TENANT.slug}/orders/${ORDER_ID}/comp`, {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ note: "Invitado de la casa" }),
    }),
    { params: Promise.resolve({ slug: TENANT.slug, orderId: ORDER_ID }) },
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "postgresql://u:p@localhost:5432/test");
  h.invoice = null;
  h.creditedCents = 0;
  h.session = { user: { id: "admin-1", role: "operator", email: "admin@sonymelona.co" } };
});

describe("quién puede dar cortesías", () => {
  it("el datáfono nunca: 403 y la cuenta queda como estaba", async () => {
    seed([]);
    h.session = { user: { id: "pos-1", role: "terminal", email: "datafono@sonymelona.co" } };
    const { status, json } = await comp();
    expect(status).toBe(403);
    expect(json).toMatchObject({ error: "forbidden" });
    expect(h.fake.order()).toMatchObject({ status: "paying", subtotalCents: 63_470_000 });
  });
});

describe("cortesía con pagos pendientes", () => {
  it("el comensal pidió datáfono del comercio: la solicitud se declina y la cuenta cierra en $0", async () => {
    seed([{ id: "req-datafono", method: "external_terminal", status: "pending", amountCents: 69_817_000, tipCents: 6_347_000 }]);
    const { status, json } = await comp();
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(h.fake.payment("req-datafono")?.status).toBe("declined");
    expect(h.fake.order()).toMatchObject({ status: "paid", subtotalCents: 0 });
  });

  it("un PSE en curso: 409 pending_payment_in_flight y la cuenta queda como estaba", async () => {
    seed([{ id: "pse", method: "kushki_pse", status: "pending", amountCents: 63_470_000 }]);
    const { status, json } = await comp();
    expect(status).toBe(409);
    expect(json).toMatchObject({ error: "pending_payment_in_flight", pending: { paymentId: "pse" } });
    expect(h.fake.payment("pse")?.status).toBe("pending");
    expect(h.fake.order()).toMatchObject({ status: "paying", subtotalCents: 63_470_000 });
  });

  it("con algo ya cobrado no se regala, y la solicitud del comensal no se toca", async () => {
    seed([
      { method: "cash", status: "approved", amountCents: 10_000_000 },
      { id: "req-cash", method: "cash", status: "pending", amountCents: 53_470_000 },
    ]);
    const { status, json } = await comp();
    expect(status).toBe(409);
    expect(json.error).toBe("order_closed_or_payment_pending");
    expect(h.fake.payment("req-cash")?.status).toBe("pending");
  });
});

describe("cortesía de una cuenta ya facturada (factura antes de cobrar)", () => {
  const invoice = { id: "inv-1", invoiceNumber: 6490, snapshot: { invoicePrefix: "FESM" }, totalCents: 63_470_000 };

  it("con la factura viva no se regala una venta facturada: 409 order_invoiced", async () => {
    seed([]);
    h.invoice = invoice;
    const { status, json } = await comp();
    expect(status).toBe(409);
    expect(json).toEqual({ error: "order_invoiced", invoice: { invoiceId: "inv-1", documentNumber: "FESM6490" } });
    expect(h.fake.order()).toMatchObject({ status: "paying", subtotalCents: 63_470_000 });
  });

  it("anulada entera con nota crédito (el cliente se fue): se cierra sin cobro, CANCELADA y sin paidAt", async () => {
    // Sin `paidAt` ni la factura ni su anulación entran a libros ni a los
    // reportes que cortan por la cuenta cobrada.
    seed([]);
    h.invoice = invoice;
    h.creditedCents = 63_470_000;
    const { status, json } = await comp();
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(h.fake.order()).toMatchObject({ status: "cancelled", paidAt: null, subtotalCents: 0 });
  });

  it("una nota parcial no alcanza: sigue siendo una venta facturada", async () => {
    seed([]);
    h.invoice = invoice;
    h.creditedCents = 10_000_000;
    expect((await comp()).status).toBe(409);
  });
});

