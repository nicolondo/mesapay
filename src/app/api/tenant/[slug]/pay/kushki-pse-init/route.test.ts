import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePaymentsDb } from "@/test/fakePaymentsDb";

/**
 * Mismo hueco que en `pay/kushki-charge`: cualquier fallo de
 * `/transfer/v1/init` dejaba el pago PSE `pending` con
 * `reconciliationRequired` (comensal en «Estamos verificando tu pago», mesa
 * bloqueada). Un 4xx reconocible de Kushki es el rechazo del INICIO de la
 * transferencia: no hay URL del banco, así que nadie pudo autorizarla, y se
 * declina por el camino de `pse.declined`. Red, timeout y 5xx siguen
 * inciertos.
 *
 * Ruta real y procesador del webhook real, contra la base en memoria. Kushki
 * NUNCA se llama: `fetch` es un doble.
 */

const h = vi.hoisted(() => ({
  fake: null as unknown as ReturnType<typeof import("@/test/fakePaymentsDb").createFakePaymentsDb>,
  events: [] as Array<Record<string, unknown> & { id: string; eventId: string }>,
  publish: vi.fn(),
  fetch: vi.fn(),
}));

const TENANT = {
  id: "rest-1",
  slug: "local",
  name: "Local de prueba",
  country: "CO",
  adminOnlyCharge: false,
  kushkiMerchantId: "merchant-1",
  kushkiOnboardingStatus: "active",
  kushkiPublicKey: "public-key",
  kushkiMode: "production",
};

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

vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/lib/db", () => ({
  db: {
    restaurant: { findUnique: vi.fn(async () => TENANT) },
    order: { findUnique: (a: never) => h.fake.tx.order.findUnique(a) },
    payment: {
      updateMany: (a: never) => h.fake.tx.payment.updateMany(a),
      update: (a: never) => h.fake.tx.payment.update(a),
    },
    kushkiTransaction: { upsert: (a: never) => h.fake.tx.kushkiTransaction.upsert(a) },
    $transaction: (cb: never) => h.fake.$transaction(cb),
  },
}));
vi.mock("@/auth", () => ({ auth: async () => null }));
vi.mock("@/lib/orderLock", () => ({ lockOrder: async () => {} }));
vi.mock("@/lib/events", () => ({ publishOrderEvent: h.publish }));
vi.mock("@/lib/invoiceOnPaid", () => ({ issueInvoiceOnPaid: async () => ({ status: "skipped" }) }));
vi.mock("@/lib/prepaidRounds", () => ({ activateOpenRounds: async () => [] }));
vi.mock("@/lib/kds/autoFireTickets", () => ({ notifyAutoFiredTickets: async () => {} }));
vi.mock("@/lib/env", () => ({ env: {}, requireKushkiKey: () => "test" }));
vi.mock("@/lib/platformConfig", () => ({
  getRestaurantKushkiMode: async () => "production",
  getKushkiModeSync: () => "production",
}));
vi.mock("@/lib/http/publicOrigin", () => ({ appOrigin: () => "https://local.example.test" }));
vi.mock("@/lib/walletTrackingCapture", () => ({ capturePaymentTrackingFields: async () => ({}) }));
vi.mock("@/lib/payments/mockBridge", () => ({ ensureMockBridge: () => {} }));
vi.mock("@/lib/payments", () => ({
  getPaymentProvider: vi.fn(),
  getRestaurantPrivateKey: async () => "private-key",
}));

import { POST } from "./route";

const ORDER_ID = "order-7";
const TOTAL = 8_580_000;
const TIP = 780_000;

function seed() {
  h.events = [];
  h.fake = createFakePaymentsDb({
    order: { id: ORDER_ID, status: "paying", subtotalCents: TOTAL - TIP, tableId: "table-4" },
    rounds: [{ status: "served" }],
    extraTx: { kushkiWebhookEvent },
  });
}

async function initPse() {
  const res = (await POST(
    new Request(`http://localhost/api/tenant/${TENANT.slug}/pay/kushki-pse-init`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        orderId: ORDER_ID,
        amountCents: TOTAL,
        tipCents: TIP,
        bankCode: "1007",
        buyer: { email: "comensal@example.test", docType: "CC", docNumber: "12345678", personType: "natural" },
        token: "pse-token-de-prueba",
      }),
    }),
    { params: Promise.resolve({ slug: TENANT.slug }) },
  )) as Response;
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const kushkiSays = (status: number, body: unknown) =>
  h.fetch.mockResolvedValueOnce(new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));

let logged: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", h.fetch);
  vi.spyOn(console, "log").mockImplementation(() => {});
  logged = vi.spyOn(console, "error").mockImplementation(() => {});
  seed();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("kushki-pse-init: Kushki rechaza el inicio de la transferencia (4xx con código)", () => {
  it("el pago queda rechazado, la cuenta libre y nunca «en verificación»", async () => {
    kushkiSays(400, { code: "K322", message: "Transacción rechazada." });

    const { status, json } = await initPse();

    const payment = h.fake.state.payments[0];
    expect(status).toBe(200);
    expect(json).toEqual({ paymentId: payment.id, approved: false, error: "payment_declined" });
    expect(payment).toMatchObject({ method: "kushki_pse", status: "declined", reconciliationRequired: false });
    expect(h.fake.order().status).toBe("served");
    expect(h.events).toEqual([expect.objectContaining({ eventId: `pse:${payment.id}:declined`, type: "pse.declined" })]);
    expect(h.publish).toHaveBeenCalledWith("rest-1", expect.objectContaining({ type: "payment.declined", paymentId: payment.id }));
    expect(logged).toHaveBeenCalledWith("pse_init_declined", expect.objectContaining({ paymentId: payment.id, status: 400, code: "K322", name: "KushkiHttpError" }));
    // Ni el token, ni la llave, ni el correo del comprador van al log.
    expect(JSON.stringify(logged.mock.calls)).not.toMatch(/pse-token-de-prueba|private-key|comensal@example\.test/);
  });
});

describe("kushki-pse-init: lo que sigue incierto", () => {
  async function expectUncertain() {
    const { status, json } = await initPse();
    const payment = h.fake.state.payments[0];
    expect(status).toBe(202);
    expect(json).toEqual({ error: "payment_pending", paymentId: payment.id, pending: true });
    expect(payment).toMatchObject({ status: "pending", reconciliationRequired: true });
    expect(h.fake.order().status).toBe("paying");
    expect(h.events).toEqual([]);
  }

  it.each([500, 503])("HTTP %i → 202 payment_pending", async (httpStatus) => {
    kushkiSays(httpStatus, { code: "K322", message: "Transacción rechazada." });
    await expectUncertain();
  });

  it("error de red → incierto", async () => {
    h.fetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expectUncertain();
  });

  it("timeout → incierto", async () => {
    h.fetch.mockRejectedValueOnce(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
    await expectUncertain();
  });

  it("4xx que habla del token (ya usado / vencido) → incierto", async () => {
    kushkiSays(400, { code: "577", message: "Token de la transacción no válido" });
    await expectUncertain();
  });

  it("2xx sin URL del banco → incierto, como antes", async () => {
    kushkiSays(200, { transactionReference: "ref-1" });
    await expectUncertain();
  });
});

describe("kushki-pse-init: camino feliz", () => {
  it("devuelve la URL del banco y deja el pago pendiente con su referencia", async () => {
    kushkiSays(200, { redirectUrl: "https://banco.example.test/pse", transactionReference: "ref-9" });
    const { status, json } = await initPse();
    const payment = h.fake.state.payments[0];
    expect(status).toBe(200);
    expect(json).toEqual({ paymentId: payment.id, redirectUrl: "https://banco.example.test/pse" });
    expect(payment).toMatchObject({ status: "pending", providerRef: "ref-9", reconciliationRequired: false });
  });
});
