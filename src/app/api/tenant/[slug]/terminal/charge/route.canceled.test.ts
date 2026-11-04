import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePaymentsDb } from "@/test/fakePaymentsDb";

/**
 * Son y Melona, 2026-11-04: el cobro llegó al datáfono, la persona canceló en
 * el equipo y Kushki contestó HTTP 200
 * `{"type":"TERMINAL","code":"TER-004","message":"User cancel the process"}`.
 * `terminal/charge` lo trataba como "no se sabe": pago `pending` con
 * `reconciliationRequired` y la cuenta bloqueada hasta "Resolver cobro".
 *
 *   - Cancelación explícita (TER-004 / MAN-30005) → se declina como un
 *     rechazo del banco y la cuenta queda libre al instante.
 *   - Otro código del equipo (p. ej. TER-003) → sigue incierto, pero con la
 *     respuesta guardada en el reclamo: el staff puede cerrarlo sin esperar.
 *   - Sin respuesta (timeout, red, 5xx, TER-002) → incierto y SIN respuesta:
 *     sólo "Resolver cobro".
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
    financialOperation: { updateMany: (a: never) => h.fake.tx.financialOperation.updateMany(a) },
    terminalDevice: { findUnique: vi.fn(async () => DEVICE), update: vi.fn(async () => DEVICE) },
    $transaction: (cb: never) => h.fake.$transaction(cb),
  },
}));
vi.mock("@/auth", () => ({ auth: async () => ({ user: { id: "mesero-1", role: "mesero", restaurantId: "rest-1" } }) }));
vi.mock("@/lib/activeRestaurant", () => ({
  getActiveContext: async () => ({ restaurantId: "rest-1", session: { user: { id: "mesero-1", role: "mesero" } } }),
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
// Sin respuesta, la ruta busca el resultado en Kushki (route.recovery.test.ts);
// acá Kushki "no sabe nada" y el pago queda incierto como antes.
vi.mock("@/lib/payments/terminalRecovery", () => ({
  recoverTerminalOutcome: async () => ({ status: "unresolved", last: "not_found" }),
}));
vi.mock("@/lib/payments", () => ({ getPaymentProvider: vi.fn() }));

import { POST } from "./route";

const ORDER_ID = "order-11";
const PAYMENT_ID = "cmvx2t4va0001g2znoepu6k0u";
const TOTAL = 9_185_000; // $91.850

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

const claim = () => h.fake.state.financialOperations.find((o) => o.key === `terminal:${PAYMENT_ID}`);

describe("terminal/charge: el datáfono canceló (TER-004)", () => {
  it("el caso real: el pago se declina, el reclamo queda failed con la respuesta y la cuenta libre", async () => {
    kushkiSays(200, {
      type: "TERMINAL",
      code: "TER-004",
      message: "User cancel the process",
      object: { client_transaction_id: "c-1", terminal_id: "123321", serial_number: "P3F6P624J0139" },
    });

    const { status, json } = await charge();

    expect(status).toBe(402);
    expect(json).toMatchObject({ ok: false, status: "canceled", error: "terminal_canceled" });
    expect(h.fake.payment(PAYMENT_ID)).toMatchObject({ status: "declined", reconciliationRequired: false });
    expect(claim()).toMatchObject({
      status: "failed",
      deviceId: "kd-1",
      answerCode: "TERMINAL/TER-004",
      answerMessage: "User cancel the process",
      answeredAt: expect.any(Date),
    });
    expect(h.fake.order().status).toBe("served");
    expect(h.events).toEqual([expect.objectContaining({ type: "terminal.declined" })]);
    expect(h.publish).toHaveBeenCalledWith("rest-1", expect.objectContaining({ type: "payment.declined", paymentId: PAYMENT_ID }));
    // Y la cuenta ya se cobra de otra forma.
    await expect(
      h.fake.tx.payment.create({ data: { orderId: ORDER_ID, method: "cash", status: "approved", amountCents: TOTAL, tipCents: 0 } }),
    ).resolves.toMatchObject({ status: "approved" });
  });

  it("MAN-30005 (se venció la lectura de la tarjeta) también libera la cuenta", async () => {
    kushkiSays(200, { type: "TERMINAL-SUNMI", code: "MAN-30005", message: "Input PIN timeout" });
    expect((await charge()).json).toMatchObject({ status: "canceled" });
    expect(h.fake.payment(PAYMENT_ID)).toMatchObject({ status: "declined", reconciliationRequired: false });
  });
});

describe("terminal/charge: el equipo contestó que no, sin ser definitivo", () => {
  it("TER-003: queda incierto (la cuenta sigue bloqueada) pero con la respuesta guardada", async () => {
    kushkiSays(200, { type: "TERMINAL", code: "TER-003", message: "Terminal is busy processing transaction" });

    const { status, json } = await charge();

    expect(status).toBe(202);
    expect(json).toEqual({ pending: true, error: "payment_pending", terminal: "answered" });
    expect(h.fake.payment(PAYMENT_ID)).toMatchObject({ status: "pending", reconciliationRequired: true });
    expect(claim()).toMatchObject({ status: "pending", answerCode: "TERMINAL/TER-003", answeredAt: expect.any(Date) });
    // Las pantallas se enteran sin esperar el sondeo.
    expect(h.publish).toHaveBeenCalledWith("rest-1", { type: "order.updated", orderId: ORDER_ID });
    await expect(
      h.fake.tx.payment.create({ data: { orderId: ORDER_ID, method: "cash", status: "approved", amountCents: TOTAL, tipCents: 0 } }),
    ).rejects.toThrow(/amount_exceeds_outstanding/);
  });
});

describe("terminal/charge: sin respuesta del equipo sigue como antes", () => {
  it.each([
    ["TER-002 (no responde)", 200, { type: "TERMINAL", code: "TER-002", message: "Terminal is not responding" }],
    ["503", 503, { type: "INTERNAL", code: "UPSTREAM", message: "boom" }],
  ])("%s → incierto y SIN respuesta guardada", async (_label, httpStatus, body) => {
    kushkiSays(httpStatus as number, body);
    expect((await charge()).status).toBe(202);
    expect(h.fake.payment(PAYMENT_ID)).toMatchObject({ status: "pending", reconciliationRequired: true });
    expect(claim()).toMatchObject({ status: "pending", answeredAt: null, deviceId: "kd-1" });
    expect(h.publish).toHaveBeenCalledWith("rest-1", { type: "order.updated", orderId: ORDER_ID });
  });

  it("timeout → incierto y sin respuesta", async () => {
    h.fetch.mockRejectedValueOnce(Object.assign(new Error("aborted"), { name: "AbortError" }));
    expect((await charge()).status).toBe(202);
    expect(claim()).toMatchObject({ answeredAt: null });
  });
});
