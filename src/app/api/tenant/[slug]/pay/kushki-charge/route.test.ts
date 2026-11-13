import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePaymentsDb } from "@/test/fakePaymentsDb";

/**
 * Producción, 2026-11-13: un comensal pagó con Apple Pay desde la mesa y
 * Kushki RECHAZÓ el cargo (HTTP 400, K322 «Transacción rechazada»,
 * antifraude). `kushki-charge` trataba cualquier excepción del proveedor
 * como incierta: el pago quedaba `pending` con `reconciliationRequired`, al
 * comensal le quedaba «Estamos verificando tu pago» para siempre y al
 * personal «Pago en línea en curso», con la mesa bloqueada.
 *
 * Un 4xx con un error reconocible de Kushki es un rechazo definitivo: se
 * liquida por el mismo camino que un `charge.declined`. Red, timeout, 5xx y
 * «token ya usado» siguen inciertos (el cargo pudo haberse procesado).
 *
 * Ruta real y procesador del webhook real, contra la base en memoria. Kushki
 * NUNCA se llama: el proveedor es un doble.
 */

const h = vi.hoisted(() => ({
  fake: null as unknown as ReturnType<typeof import("@/test/fakePaymentsDb").createFakePaymentsDb>,
  events: [] as Array<Record<string, unknown> & { id: string; eventId: string }>,
  publish: vi.fn(),
  charge: vi.fn(),
}));

const TENANT = {
  id: "rest-1",
  slug: "local",
  country: "CO",
  adminOnlyCharge: false,
  kushkiMerchantId: "merchant-1",
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
    order: {
      findUnique: (a: never) => h.fake.tx.order.findUnique(a),
      findUniqueOrThrow: (a: never) => h.fake.tx.order.findUniqueOrThrow(a),
      update: (a: never) => h.fake.tx.order.update(a),
    },
    payment: { updateMany: (a: never) => h.fake.tx.payment.updateMany(a) },
    kushkiTransaction: { upsert: (a: never) => h.fake.tx.kushkiTransaction.upsert(a) },
    $transaction: (cb: never) => h.fake.$transaction(cb),
  },
}));
vi.mock("@/auth", () => ({ auth: async () => null }));
vi.mock("@/lib/activeRestaurant", () => ({ getActiveContext: async () => null }));
vi.mock("@/lib/orderLock", () => ({ lockOrder: async () => {} }));
vi.mock("@/lib/events", () => ({ publishOrderEvent: h.publish }));
vi.mock("@/lib/invoiceOnPaid", () => ({ issueInvoiceOnPaid: async () => ({ status: "skipped" }) }));
vi.mock("@/lib/prepaidRounds", () => ({ activateOpenRounds: async () => [] }));
vi.mock("@/lib/kds/autoFireTickets", () => ({ notifyAutoFiredTickets: async () => {} }));
vi.mock("@/lib/mailer", () => ({ welcomeIfFirstTime: async () => {} }));
vi.mock("@/lib/env", () => ({ env: {}, requireKushkiKey: () => "test" }));
vi.mock("@/lib/platformConfig", () => ({
  getRestaurantKushkiMode: async () => "production",
  getKushkiModeSync: () => "production",
}));
vi.mock("@/lib/billing/countries", () => ({ getCurrencyForCountry: async () => "COP" }));
vi.mock("@/lib/walletTrackingCapture", () => ({ capturePaymentTrackingFields: async () => ({}) }));
vi.mock("@/lib/payments", () => ({
  getPaymentProvider: async () => ({ chargeWithToken: h.charge }),
  getRestaurantPrivateKey: async () => "private-key",
}));

import { KushkiHttpError, KushkiSchemaError } from "@/lib/payments/kushki/client";
import { POST } from "./route";

const ORDER_ID = "order-7";
const TOTAL = 8_580_000;
const TIP = 780_000;
const TOKEN = "apple-pay-token-de-prueba";
const CHARGES_URL = "https://api.kushkipagos.com/card/v1/charges";

function seed() {
  h.events = [];
  h.fake = createFakePaymentsDb({
    order: { id: ORDER_ID, status: "paying", subtotalCents: TOTAL - TIP, tableId: "table-4" },
    rounds: [{ status: "served" }],
    extraTx: { kushkiWebhookEvent },
  });
}

async function pay(method: "kushki_apple_pay" | "kushki_card" = "kushki_apple_pay") {
  const res = (await POST(
    new Request(`http://localhost/api/tenant/${TENANT.slug}/pay/kushki-charge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orderId: ORDER_ID, method, token: TOKEN, amountCents: TOTAL, tipCents: TIP }),
    }),
    { params: Promise.resolve({ slug: TENANT.slug }) },
  )) as Response;
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const kushkiRejects = (status: number, body: unknown) =>
  h.charge.mockRejectedValueOnce(new KushkiHttpError(status, typeof body === "string" ? body : JSON.stringify(body), CHARGES_URL));

let logged: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  logged = vi.spyOn(console, "error").mockImplementation(() => {});
  seed();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("kushki-charge: Kushki rechaza el cargo con un 4xx (K322)", () => {
  it("el pago queda rechazado (no incierto), la cuenta libre y la respuesta es la del rechazo normal", async () => {
    kushkiRejects(400, { code: "K322", message: "Transacción rechazada." });

    const { status, json } = await pay();

    const payment = h.fake.state.payments[0];
    // Misma forma que un `charge.declined` (200, approved:false) + el motivo.
    expect(status).toBe(200);
    expect(json).toEqual({ paymentId: payment.id, approved: false, error: "payment_declined", reason: "security_rejected" });
    expect(payment).toMatchObject({ method: "kushki_apple_pay", status: "declined", reconciliationRequired: false });
    // La cuenta sale de «pagando» y vuelve al estado de su cocina.
    expect(h.fake.order().status).toBe("served");
    // Mismo camino que el rechazo normal: evento idempotente + avisos a las pantallas.
    expect(h.events).toEqual([expect.objectContaining({ eventId: `charge:${payment.id}:declined`, type: "charge.declined" })]);
    expect(h.publish).toHaveBeenCalledWith("rest-1", expect.objectContaining({ type: "payment.declined", paymentId: payment.id }));
    expect(h.publish).toHaveBeenCalledWith("rest-1", expect.objectContaining({ type: "order.updated", orderId: ORDER_ID }));
    // El motivo queda guardado para auditoría.
    expect(h.fake.state.kushkiTransactions).toEqual([
      expect.objectContaining({
        paymentId: payment.id,
        kushkiTxId: `rejected:${payment.id}`,
        kind: "charge",
        status: "declined",
        message: "K322 · Transacción rechazada.",
        raw: expect.objectContaining({ httpStatus: 400, code: "K322", reason: "security_rejected" }),
      }),
    ]);
    // Y el personal ya puede cobrar por otro medio (el trigger lo deja).
    await expect(
      h.fake.tx.payment.create({ data: { orderId: ORDER_ID, method: "cash", status: "approved", amountCents: TOTAL, tipCents: TIP } }),
    ).resolves.toMatchObject({ status: "approved" });
  });

  it("el log lleva status HTTP, código de Kushki y el nombre real del error; nunca el token ni el cuerpo", async () => {
    kushkiRejects(400, { code: "K322", message: "Transacción rechazada.", details: { cardHolderName: "TITULAR PRUEBA" } });
    await pay();
    const payment = h.fake.state.payments[0];
    expect(logged).toHaveBeenCalledWith("charge_declined", {
      paymentId: payment.id,
      outcome: "declined",
      reason: "security_rejected",
      status: 400,
      code: "K322",
      name: "KushkiHttpError",
    });
    expect(JSON.stringify(logged.mock.calls)).not.toMatch(new RegExp(`${TOKEN}|TITULAR PRUEBA|private-key`));
  });

  it("tarjeta con fondos insuficientes (021) → rechazo con su motivo", async () => {
    kushkiRejects(402, { code: "021", message: "Fondos insuficientes" });
    const { status, json } = await pay("kushki_card");
    expect(status).toBe(200);
    expect(json).toMatchObject({ approved: false, error: "payment_declined", reason: "card_funds" });
    expect(h.fake.state.payments[0]).toMatchObject({ status: "declined", reconciliationRequired: false });
  });

  it("repetir el mismo token no vuelve a cobrar: devuelve el pago ya rechazado", async () => {
    kushkiRejects(400, { code: "K322", message: "Transacción rechazada." });
    await pay();
    const again = await pay();
    expect(h.charge).toHaveBeenCalledTimes(1);
    expect(again.json).toMatchObject({ paymentId: h.fake.state.payments[0].id, approved: false, pending: false });
    expect(h.fake.state.payments).toHaveLength(1);
  });
});

describe("kushki-charge: lo que sigue incierto (el cargo pudo haberse procesado)", () => {
  async function expectUncertain() {
    const { status, json } = await pay();
    const payment = h.fake.state.payments[0];
    expect(status).toBe(202);
    expect(json).toEqual({ error: "payment_pending", paymentId: payment.id, pending: true });
    expect(payment).toMatchObject({ status: "pending", reconciliationRequired: true });
    expect(h.fake.order().status).toBe("paying");
    expect(h.events).toEqual([]);
    return payment;
  }

  it.each([500, 502, 503, 504])("HTTP %i → 202 payment_pending", async (httpStatus) => {
    kushkiRejects(httpStatus, { code: "K322", message: "Transacción rechazada." });
    const payment = await expectUncertain();
    expect(logged).toHaveBeenCalledWith("charge_uncertain", {
      paymentId: payment.id,
      outcome: "uncertain",
      cause: "http_5xx",
      status: httpStatus,
      code: "K322",
      name: "KushkiHttpError",
    });
  });

  it.each([408, 409, 429])("HTTP %i → incierto", async (httpStatus) => {
    kushkiRejects(httpStatus, { code: "K322", message: "Transacción rechazada." });
    await expectUncertain();
  });

  it("token ya usado (577) → incierto: un intento previo pudo haber cobrado", async () => {
    kushkiRejects(400, { code: "577", message: "Token de la transacción no válido" });
    await expectUncertain();
  });

  it("error de red → incierto", async () => {
    h.charge.mockRejectedValueOnce(new TypeError("fetch failed"));
    const payment = await expectUncertain();
    expect(logged).toHaveBeenCalledWith("charge_uncertain", {
      paymentId: payment.id,
      outcome: "uncertain",
      cause: "network",
      status: null,
      code: null,
      name: "TypeError",
    });
  });

  it("timeout → incierto", async () => {
    h.charge.mockRejectedValueOnce(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }));
    await expectUncertain();
  });

  it("2xx que no parsea (KushkiSchemaError) → incierto", async () => {
    h.charge.mockRejectedValueOnce(new KushkiSchemaError(CHARGES_URL, "schema mismatch", "{}"));
    await expectUncertain();
  });

  it("4xx con cuerpo no reconocible (HTML de un proxy) → incierto", async () => {
    kushkiRejects(400, "<html>Bad Request</html>");
    await expectUncertain();
  });
});

describe("kushki-charge: los caminos que ya existían no cambian", () => {
  it("aprobado: el pago queda aprobado y la cuenta pagada", async () => {
    h.charge.mockResolvedValueOnce({ providerRef: "tx-ok", status: "approved", raw: { ticketNumber: "1" } });
    const { status, json } = await pay();
    const payment = h.fake.state.payments[0];
    expect(status).toBe(200);
    expect(json).toMatchObject({ paymentId: payment.id, approved: true });
    expect(payment).toMatchObject({ status: "approved", providerRef: "tx-ok" });
  });

  it("rechazado con respuesta 2xx: misma respuesta de rechazo", async () => {
    h.charge.mockResolvedValueOnce({ providerRef: "tx-no", status: "declined", message: "Rechazada", raw: {} });
    const { status, json } = await pay();
    const payment = h.fake.state.payments[0];
    expect(status).toBe(200);
    expect(json).toEqual({ paymentId: payment.id, approved: false, error: "payment_declined" });
    expect(payment).toMatchObject({ status: "declined", reconciliationRequired: false });
    expect(h.fake.order().status).toBe("served");
  });
});
