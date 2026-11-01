import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePaymentsDb } from "@/test/fakePaymentsDb";

/**
 * Son y Melona, 2026-10-31: con el Smart POS ya registrado (serial y
 * Business-Code), `cloudt` respondió `400 CLOUDPAYMENT_VALIDATION_ERROR`.
 * `terminal/charge` lo trataba como fallo de transporte: pago `pending` con
 * `reconciliationRequired`, reclamo `terminal:<id>` pendiente y la mesa
 * trabada otra vez. Un 4xx de validación es Kushki rechazando la SOLICITUD
 * antes de mandarla al equipo: no hubo cobro, así que se declina por el mismo
 * camino que `terminal.declined`.
 *
 * Ruta real, cliente del Cloud Terminal real y procesador del webhook real,
 * contra la base en memoria. Kushki NUNCA se llama: `fetch` es un doble.
 */

const h = vi.hoisted(() => ({
  fake: null as unknown as ReturnType<typeof import("@/test/fakePaymentsDb").createFakePaymentsDb>,
  events: [] as Array<Record<string, unknown> & { id: string; eventId: string }>,
  publish: vi.fn(),
  fetch: vi.fn(),
}));

const TENANT = {
  id: "rest-1",
  slug: "sonymelona",
  country: "CO",
  adminOnlyCharge: false,
  suspended: false,
  enabledPaymentMethods: ["cash", "kushki_card_terminal"],
  kushkiMode: "production",
  cloudTerminalBusinessCode: "bc-test",
};
const DEVICE = { id: "dev-1", kushkiDeviceId: "kd-1", restaurantId: "rest-1", active: true, serialNumber: "P3F6P624J0139", label: "Caja" };

const kushkiWebhookEvent = {
  createMany: async ({ data }: { data: Array<{ eventId: string }> }) => {
    for (const d of data) if (!h.events.some((e) => e.eventId === d.eventId)) h.events.push({ id: `ev-${h.events.length + 1}`, ...d });
    return { count: data.length };
  },
  findUniqueOrThrow: async ({ where }: { where: { eventId: string } }) => {
    const e = h.events.find((x) => x.eventId === where.eventId);
    if (!e) throw new Error("event_not_found");
    return { processedAt: null, ...e };
  },
  update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
    const e = h.events.find((x) => x.id === where.id)!;
    Object.assign(e, data);
    return e;
  },
};

vi.mock("@/lib/db", () => ({
  db: {
    restaurant: { findUnique: vi.fn(async () => TENANT) },
    payment: {
      findUnique: (a: never) => h.fake.tx.payment.findUnique(a),
      updateMany: (a: never) => h.fake.tx.payment.updateMany(a),
    },
    terminalDevice: { findUnique: vi.fn(async () => DEVICE), update: vi.fn(async () => DEVICE) },
    $transaction: (cb: never) => h.fake.$transaction(cb),
  },
}));
vi.mock("@/auth", () => ({ auth: async () => ({ user: { id: "admin-1", role: "operator", restaurantId: "rest-1" } }) }));
vi.mock("@/lib/activeRestaurant", () => ({
  getActiveContext: async () => ({ restaurantId: "rest-1", session: { user: { id: "admin-1", role: "operator" } } }),
}));
vi.mock("@/lib/rateLimit", () => ({ rateLimit: async () => true }));
vi.mock("@/lib/guestAccess", () => ({ canAccessOrder: async () => true, canAccessTable: async () => true }));
vi.mock("@/lib/orderLock", () => ({ lockOrder: async () => {} }));
vi.mock("@/lib/events", () => ({ publishOrderEvent: h.publish }));
vi.mock("@/lib/invoiceOnPaid", () => ({ issueInvoiceOnPaid: async () => ({ status: "skipped" }) }));
vi.mock("@/lib/prepaidRounds", () => ({ activateOpenRounds: async () => [] }));
vi.mock("@/lib/kds/autoFireTickets", () => ({ notifyAutoFiredTickets: async () => {} }));
vi.mock("@/lib/env", () => ({
  env: { KUSHKI_BP_BUSINESS_CODE: undefined, KUSHKI_CLOUD_TERMINAL_PATH: undefined, KUSHKI_CLOUD_TERMINAL_DEVICE: "SUNMI-T2" },
}));
vi.mock("@/lib/platformConfig", () => ({
  getRestaurantKushkiMode: async (r: { kushkiMode?: string | null }) => r.kushkiMode ?? "mock",
  getKushkiModeSync: () => "production",
}));
vi.mock("@/lib/billing/countries", () => ({ getCurrencyForCountry: async () => "COP" }));
vi.mock("@/lib/payments/mockBridge", () => ({ ensureMockBridge: () => {} }));
vi.mock("@/lib/payments", () => ({ getPaymentProvider: vi.fn() }));

import { POST } from "./route";

const ORDER_ID = "order-9";
const PAYMENT_ID = "cmvx2t4va0001g2znoepu6k0u";
const TOTAL = 6_589_000;

function seed() {
  h.events = [];
  h.fake = createFakePaymentsDb({
    order: { id: ORDER_ID, status: "paying", subtotalCents: TOTAL },
    payments: [{ id: PAYMENT_ID, method: "kushki_card_terminal", status: "pending", amountCents: TOTAL, tipCents: 0 }],
    rounds: [{ status: "served" }],
    extraTx: { kushkiWebhookEvent },
  });
}

async function charge() {
  const res = await POST(
    new Request(`http://localhost/api/tenant/${TENANT.slug}/terminal/charge`, {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ paymentId: PAYMENT_ID, deviceId: "kd-1" }),
    }),
    { params: Promise.resolve({ slug: TENANT.slug }) },
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DATABASE_URL", "postgresql://u:p@localhost:5432/test");
  vi.stubGlobal("fetch", h.fetch);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  seed();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const kushkiSays = (status: number, body: unknown) =>
  h.fetch.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));

describe("terminal/charge: Kushki rechaza la solicitud por validación (4xx)", () => {
  it("el caso real (400 CLOUDPAYMENT_VALIDATION_ERROR): el pago se declina, el reclamo queda failed y la cuenta libre", async () => {
    kushkiSays(400, {
      type: "INTERNAL",
      code: "CLOUDPAYMENT_VALIDATION_ERROR",
      message: "Unable to validate the CloudPayment request.",
      object: { terminal_id: 4716 },
    });

    const { status, json } = await charge();

    expect(status).toBe(422);
    expect(json).toEqual({
      ok: false,
      status: "rejected",
      error: "terminal_request_rejected",
      kushki: {
        httpStatus: 400,
        type: "INTERNAL",
        code: "CLOUDPAYMENT_VALIDATION_ERROR",
        message: "Unable to validate the CloudPayment request.",
      },
    });
    // Mismo camino que terminal.declined: no queda incierto ni trabado.
    expect(h.fake.payment(PAYMENT_ID)).toMatchObject({ status: "declined", reconciliationRequired: false });
    expect(h.fake.state.financialOperations).toEqual([
      expect.objectContaining({ key: `terminal:${PAYMENT_ID}`, status: "failed" }),
    ]);
    expect(h.fake.order().status).toBe("served");
    expect(h.events).toEqual([expect.objectContaining({ type: "terminal.declined" })]);
    expect(h.publish).toHaveBeenCalledWith("rest-1", expect.objectContaining({ type: "payment.declined", paymentId: PAYMENT_ID }));
    // Y la cuenta ya se puede cobrar de otra forma (el trigger lo deja).
    await expect(
      h.fake.tx.payment.create({ data: { orderId: ORDER_ID, method: "cash", status: "approved", amountCents: TOTAL, tipCents: 0 } }),
    ).resolves.toMatchObject({ status: "approved" });
  });

  it.each([401, 403, 404, 409, 422])("HTTP %i también se declina, sin dejarlo incierto", async (httpStatus) => {
    kushkiSays(httpStatus, { failure: { type: "INTERNAL", code: `E${httpStatus}`, message: "rejected" } });
    const { status, json } = await charge();
    expect(status).toBe(422);
    expect(json).toMatchObject({ error: "terminal_request_rejected", kushki: { httpStatus, code: `E${httpStatus}` } });
    expect(h.fake.payment(PAYMENT_ID)).toMatchObject({ status: "declined", reconciliationRequired: false });
  });
});

describe("terminal/charge: 5xx, timeout y red siguen inciertos", () => {
  it.each([500, 502, 503])("HTTP %i → 202 payment_pending, pago pendiente con reconciliationRequired", async (httpStatus) => {
    kushkiSays(httpStatus, { type: "INTERNAL", code: "UPSTREAM", message: "boom" });
    const { status, json } = await charge();
    expect(status).toBe(202);
    expect(json).toEqual({ pending: true, error: "payment_pending" });
    expect(h.fake.payment(PAYMENT_ID)).toMatchObject({ status: "pending", reconciliationRequired: true });
    expect(h.fake.state.financialOperations).toEqual([expect.objectContaining({ status: "pending" })]);
  });

  it("error de red → incierto", async () => {
    h.fetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect((await charge()).status).toBe(202);
    expect(h.fake.payment(PAYMENT_ID)).toMatchObject({ status: "pending", reconciliationRequired: true });
  });

  it("timeout → incierto", async () => {
    h.fetch.mockRejectedValueOnce(Object.assign(new Error("aborted"), { name: "AbortError" }));
    expect((await charge()).status).toBe(202);
    expect(h.fake.payment(PAYMENT_ID)).toMatchObject({ status: "pending", reconciliationRequired: true });
  });
});
