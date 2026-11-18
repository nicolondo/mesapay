import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePaymentsDb } from "@/test/fakePaymentsDb";
import { tipBaseOfItems } from "@/lib/tipBase";
import { tipCentsFor } from "@/lib/tips";

/**
 * El servidor cobra la propina que la pantalla calculó sobre el valor ANTES
 * de impuestos: la propina es voluntaria (la ruta no la recalcula, sólo
 * exige `tipCents ≤ amountCents`) y la cuenta se cierra por la porción de
 * COMIDA (`amountCents − tipCents`), así que la nueva base nunca deja una
 * cuenta abierta ni rechaza un cobro. Corre la ruta REAL contra la base en
 * memoria que reproduce el trigger `mesapay_reserve_payment`.
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

const ORDER_ID = "order-propina";
// $108.000 de carta con INC 8 % embebido: sin impuesto, $100.000.
const SUBTOTAL = 10_800_000;
const TIP_BASE = tipBaseOfItems(
  [{ nameSnapshot: "Consumo", qty: 1, priceCentsSnapshot: SUBTOTAL, cancelledAt: null, taxKind: null, taxPct: null }],
  { kind: "inc", pct: 8 },
);

function seed() {
  h.fake = createFakePaymentsDb({
    order: { id: ORDER_ID, status: "paying", subtotalCents: SUBTOTAL, tableId: "table-3" },
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
  h.session = ADMIN;
  seed();
});

describe("cobro con la propina sobre el valor antes de impuestos", () => {
  it("$108.000 + 10 % de $100.000 = $118.000: se aprueba y la cuenta queda pagada con $10.000 de propina", async () => {
    const tip = tipCentsFor(SUBTOTAL, 10, TIP_BASE);
    expect(tip).toBe(1_000_000);
    const { status, json } = await pay({ method: "cash", amountCents: SUBTOTAL + tip, tipCents: tip, settleNow: true });
    expect(status).toBe(200);
    expect(json).toMatchObject({ paid: true });
    expect(h.fake.order()).toMatchObject({ status: "paid", tipCents: 1_000_000, totalCents: 11_800_000 });
  });

  it("partes iguales × 2: cada parte lleva la propina de su base proporcional y la cuenta cierra exacta", async () => {
    const part = SUBTOTAL / 2;
    const tip = tipCentsFor(part, 10, TIP_BASE);
    expect(tip).toBe(500_000);
    const first = await pay({ method: "cash", amountCents: part + tip, tipCents: tip, settleNow: true });
    expect(first.json).toMatchObject({ paid: false });
    const second = await pay({ method: "cash", amountCents: part + tip, tipCents: tip, settleNow: true });
    expect(second.json).toMatchObject({ paid: true });
    expect(h.fake.order()).toMatchObject({ status: "paid", tipCents: 1_000_000, totalCents: 11_800_000 });
  });

  it("la propina sigue siendo voluntaria: un monto fijo (o ninguna) también cierra la cuenta", async () => {
    const { json } = await pay({ method: "cash", amountCents: SUBTOTAL + 1_080_000, tipCents: 1_080_000, settleNow: true });
    expect(json).toMatchObject({ paid: true });
    expect(h.fake.order()).toMatchObject({ tipCents: 1_080_000 });
  });

  it("la comida que excede lo pendiente se sigue rechazando aunque se llame propina de menos", async () => {
    const { status } = await pay({ method: "cash", amountCents: SUBTOTAL + 1_000_000, tipCents: 0, settleNow: true });
    expect(status).toBe(409);
    expect(h.fake.order().status).not.toBe("paid");
  });
});
