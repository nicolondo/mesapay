import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePaymentsDb } from "@/test/fakePaymentsDb";

/**
 * La carrera entre empujar un cobro al datáfono Kushki (`terminal/charge`) y
 * cobrar la cuenta de otra forma (`pay`, efectivo del staff). Las dos rutas
 * toman `lockOrder`; `terminal/charge` crea el reclamo `terminal:<id>` bajo
 * el lock y DESPUÉS de re-verificar que el pago sigue pendiente. El resultado
 * tiene que ser uno de dos, nunca un cobro doble:
 *
 *   - el efectivo llega primero → la solicitud se declina y el empuje rebota
 *     sin llamar a Kushki;
 *   - el reclamo llega primero → el efectivo rebota con 409
 *     pending_payment_in_flight y la solicitud queda en vuelo.
 *
 * Rutas reales con `secureApi` real contra la base en memoria. Kushki NUNCA
 * se llama: `pushPaymentToCloudTerminal` es un doble.
 */

const h = vi.hoisted(() => ({
  fake: null as unknown as ReturnType<typeof import("@/test/fakePaymentsDb").createFakePaymentsDb>,
  session: null as null | { user: { id: string; role: string; restaurantId: string } },
  push: vi.fn(),
  webhook: vi.fn(),
  publish: vi.fn(),
  // Corre después de que `terminal/charge` leyó el pago (fuera de su
  // transacción) y antes de que tome el lock: otro proceso que se adelanta.
  afterTerminalPreRead: null as null | (() => Promise<void>),
}));

const TENANT = {
  id: "rest-1",
  slug: "sonymelona",
  name: "Son y Melona",
  country: "CO",
  adminOnlyCharge: false,
  suspended: false,
  enabledPaymentMethods: ["cash", "kushki_card_terminal"],
  kushkiMode: "production",
  cloudTerminalBusinessCode: "bc-test",
};
const DEVICE = { id: "dev-1", kushkiDeviceId: "kd-1", restaurantId: "rest-1", active: true, serialNumber: "PAX-0001", label: "Caja" };

vi.mock("@/lib/db", () => ({
  db: {
    restaurant: { findUnique: vi.fn(async () => TENANT) },
    order: {
      findFirst: (a: never) => h.fake.tx.order.findFirst(a),
      findUnique: (a: never) => h.fake.tx.order.findUnique(a),
    },
    payment: {
      findUnique: async (a: { include?: { order?: boolean } }) => {
        const row = await h.fake.tx.payment.findUnique(a as never);
        // Sólo la lectura previa de terminal/charge trae la orden incluida.
        if (a.include?.order && h.afterTerminalPreRead) {
          const hook = h.afterTerminalPreRead;
          h.afterTerminalPreRead = null;
          await hook();
        }
        return row;
      },
      findMany: (a: never) => h.fake.tx.payment.findMany(a),
      updateMany: (a: never) => h.fake.tx.payment.updateMany(a),
    },
    terminalDevice: {
      findUnique: vi.fn(async () => DEVICE),
      findMany: vi.fn(async () => [DEVICE]),
      update: vi.fn(async () => DEVICE),
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
vi.mock("@/lib/platformConfig", () => ({
  getRestaurantKushkiMode: async (r: { kushkiMode?: string | null }) => r.kushkiMode ?? "mock",
}));
vi.mock("@/lib/billing/countries", () => ({ getCurrencyForCountry: async () => "COP" }));
vi.mock("@/lib/payments/kushki/cloudTerminal", () => ({ pushPaymentToCloudTerminal: h.push }));
vi.mock("@/lib/payments/mockBridge", () => ({ ensureMockBridge: () => {} }));
vi.mock("@/lib/payments/webhookHandler", () => ({ processKushkiWebhook: h.webhook }));
vi.mock("@/lib/payments", () => ({ getPaymentProvider: vi.fn() }));

import { POST as CHARGE } from "./route";
import { POST as PAY } from "../../pay/route";

const ORDER_ID = "order-7";
const TOTAL = 17_457_000;
const TIP = 1_587_000;
const SMART = "smart";

function seed(pushed = false) {
  h.fake = createFakePaymentsDb({
    order: { id: ORDER_ID, status: "paying", subtotalCents: TOTAL - TIP },
    payments: [{ id: SMART, method: "kushki_card_terminal", status: "pending", amountCents: TOTAL, tipCents: TIP }],
    financialOperations: pushed ? [{ key: `terminal:${SMART}`, paymentId: SMART, amountCents: TOTAL }] : [],
  });
}

const json = (body: unknown) => ({
  method: "POST",
  headers: { host: "localhost", "content-type": "application/json" },
  body: JSON.stringify(body),
});

async function charge() {
  const res = await CHARGE(
    new Request(`http://localhost/api/tenant/${TENANT.slug}/terminal/charge`, json({ paymentId: SMART, deviceId: "kd-1" })),
    { params: Promise.resolve({ slug: TENANT.slug }) },
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function payCash() {
  const res = await PAY(
    new Request(
      `http://localhost/api/tenant/${TENANT.slug}/pay`,
      json({ orderId: ORDER_ID, method: "cash", amountCents: TOTAL, tipCents: TIP, settleNow: true }),
    ),
    { params: Promise.resolve({ slug: TENANT.slug }) },
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DATABASE_URL", "postgresql://u:p@localhost:5432/test");
  h.session = { user: { id: "admin-1", role: "operator", restaurantId: "rest-1" } };
  h.afterTerminalPreRead = null;
});

describe("terminal/charge vs. el cobro del staff", () => {
  it("el efectivo se adelanta al empuje: la solicitud se declina, el empuje rebota y Kushki no se llama", async () => {
    seed();
    let cash: Awaited<ReturnType<typeof payCash>> | null = null;
    h.afterTerminalPreRead = async () => {
      cash = await payCash();
    };

    const pushed = await charge();

    expect(cash).toMatchObject({ status: 200, json: { paid: true } });
    expect(pushed.status).toBe(409);
    expect(pushed.json.error).toBe("operation_conflict");
    expect(h.push).not.toHaveBeenCalled();
    expect(h.fake.state.financialOperations).toHaveLength(0);
    expect(h.fake.payment(SMART)?.status).toBe("declined");
    expect(h.fake.order().status).toBe("paid");
  });

  it("el empuje llega primero: mientras el datáfono procesa, el efectivo rebota con 409 en vuelo", async () => {
    seed();
    let cash: Awaited<ReturnType<typeof payCash>> | null = null;
    h.push.mockImplementation(async () => {
      cash = await payCash();
      return { status: "approved", providerRef: "cloud-123", message: "ok", raw: {} };
    });
    h.webhook.mockResolvedValue({ status: "ok" });

    const pushed = await charge();

    expect(h.push).toHaveBeenCalledOnce();
    expect(pushed).toMatchObject({ status: 200, json: { ok: true, status: "approved" } });
    expect(cash).toMatchObject({
      status: 409,
      json: { error: "pending_payment_in_flight", pending: { paymentId: SMART, method: "kushki_card_terminal" } },
    });
    expect(h.fake.state.payments.filter((p) => p.method === "cash")).toHaveLength(0);
    expect(h.fake.state.financialOperations).toEqual([expect.objectContaining({ key: `terminal:${SMART}` })]);
  });

  it("si el datáfono no responde, el pago queda incierto (reconciliationRequired) y sigue bloqueando", async () => {
    seed();
    h.push.mockRejectedValue(new Error("timeout"));

    const pushed = await charge();

    expect(pushed).toMatchObject({ status: 202, json: { pending: true, error: "payment_pending" } });
    expect(h.fake.payment(SMART)).toMatchObject({ status: "pending", reconciliationRequired: true });
    expect((await payCash()).json.error).toBe("pending_payment_in_flight");
  });

  it("primero el efectivo y después alguien toca «Cobrar»: already_settled, sin llamar a Kushki", async () => {
    seed();
    expect((await payCash()).status).toBe(200);
    const pushed = await charge();
    expect(pushed).toMatchObject({ status: 409, json: { error: "already_settled" } });
    expect(h.push).not.toHaveBeenCalled();
  });

  it("un pago ya reclamado no se vuelve a empujar (202, sin segunda llamada a Kushki)", async () => {
    seed(true);
    const pushed = await charge();
    expect(pushed.status).toBe(202);
    expect(h.push).not.toHaveBeenCalled();
  });
});
