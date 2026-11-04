import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePaymentsDb } from "@/test/fakePaymentsDb";

/**
 * Son y Melona, 2026-11-04: dos cobros reales al datáfono recibieron HTTP 504
 * con un cuerpo HTML a los ~60 s (el gateway de Kushki corta el cobro
 * síncrono) mientras el datáfono todavía esperaba la tarjeta. Quedaban
 * inciertos: el staff esperó 3 minutos, los marcó "no se cobró" y cobró en
 * efectivo sin saber qué había pasado en el equipo.
 *
 * Ahora, sin respuesta, `terminal/charge` BUSCA el resultado real en Kushki
 * (`transaction_search_online` por el `client_transaction_id` guardado en el
 * reclamo) hasta que el equipo ya no pueda responder:
 *   - aprobado → se salda igual que un aprobado del datáfono, y la factura
 *     sale por `issueInvoiceOnPaid` exactamente como en efectivo
 *     (tirilla → DIAN → impresión automática);
 *   - rechazado → cuenta libre;
 *   - nada / reversión / otro monto → incierto, como antes.
 *
 * Ruta real, cliente del Cloud Terminal real, recuperación real y procesador
 * del webhook real, contra la base en memoria. Kushki NUNCA se llama: `fetch`
 * es un doble y el reloj de la recuperación no espera de verdad.
 */

const h = vi.hoisted(() => ({
  fake: null as unknown as ReturnType<typeof import("@/test/fakePaymentsDb").createFakePaymentsDb>,
  events: [] as Array<Record<string, unknown> & { id: string; eventId: string }>,
  publish: vi.fn(),
  fetch: vi.fn(),
  issueInvoice: vi.fn(async () => ({ status: "issued" })),
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
const SERIAL = "P3F6P624J0139";
const DEVICE = { id: "dev-1", kushkiDeviceId: "kd-1", restaurantId: "rest-1", active: true, serialNumber: SERIAL, label: "Caja" };

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
    kushkiTransaction: { updateMany: (a: never) => h.fake.tx.kushkiTransaction.updateMany(a) },
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
vi.mock("@/lib/waiterCommissionsSeal", () => ({ sealOrderCommission: async () => {} }));
vi.mock("@/lib/events", () => ({ publishOrderEvent: h.publish }));
vi.mock("@/lib/invoiceOnPaid", () => ({ issueInvoiceOnPaid: h.issueInvoice }));
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
import { decryptData, tokenPassword } from "@/lib/payments/kushki/cloudTerminal";
import {
  TERMINAL_RECOVERY_INTERVAL_MS,
  TERMINAL_RECOVERY_WINDOW_MS,
  recoveryClock,
} from "@/lib/payments/terminalRecovery";

const ORDER_ID = "order-13";
const PAYMENT_ID = "cmvx2t4va0001g2znoepu6k0u";
const TOTAL = 9_185_000; // $91.850
const TIP = 835_000;

const realClock = { ...recoveryClock };
let clock = 0;

function seed() {
  h.events = [];
  h.fake = createFakePaymentsDb({
    order: { id: ORDER_ID, status: "paying", subtotalCents: TOTAL - TIP },
    payments: [{ id: PAYMENT_ID, method: "kushki_card_terminal", status: "pending", amountCents: TOTAL, tipCents: TIP }],
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

/** Lo que devuelve el gateway de Kushki a los 60 s. */
const GATEWAY_504 = "<html><head><title>504 Gateway Time-out</title></head><body><center><h1>504 Gateway Time-out</h1></center></body></html>";
const html504 = () => h.fetch.mockResolvedValueOnce(new Response(GATEWAY_504, { status: 504, headers: { "content-type": "text/html" } }));
// Lazy: el `client_transaction_id` lo genera la ruta antes de empujar, así
// que la respuesta de la búsqueda se arma recién cuando se consulta.
const searchSays = (items: unknown[] | (() => unknown[])) =>
  h.fetch.mockImplementationOnce(async () =>
    new Response(JSON.stringify({ items: typeof items === "function" ? items() : items }), { status: 200 }),
  );

const sale = (over: Record<string, unknown> = {}) => ({
  transaction_reference: "8c1d2f1e-tx-ref",
  client_transaction_id: claim()?.clientTransactionId,
  transaction_type: "SALE",
  transaction_status: "APPROVAL",
  approval_code: "482913",
  approved_transaction_amount: TOTAL / 100,
  created: Date.now(),
  ...over,
});

const claim = () => h.fake.state.financialOperations.find((o) => o.key === `terminal:${PAYMENT_ID}`);
const calls = () => h.fetch.mock.calls.map((c) => String(c[0]));
const searchCalls = () => calls().filter((u) => u.endsWith("/sync/transaction_search_online"));

beforeEach(() => {
  vi.clearAllMocks();
  h.fetch.mockReset();
  vi.stubEnv("DATABASE_URL", "postgresql://u:p@localhost:5432/test");
  vi.stubGlobal("fetch", h.fetch);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  clock = Date.now();
  recoveryClock.now = () => clock;
  recoveryClock.sleep = async (ms: number) => {
    clock += ms;
  };
  seed();
});
afterEach(() => {
  Object.assign(recoveryClock, realClock);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("terminal/charge: 504 del gateway y el datáfono aprobó", () => {
  it("busca el resultado por el client_transaction_id del reclamo, salda la cuenta y emite la factura como en efectivo", async () => {
    html504();
    // Primera consulta: el adquirente todavía no registra nada; la segunda
    // ya trae la venta aprobada.
    searchSays([]);
    h.fetch.mockImplementationOnce(async () => new Response(JSON.stringify({ items: [sale()] }), { status: 200 }));

    const { status, json } = await charge();

    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, status: "approved", recovered: true, providerRef: "8c1d2f1e-tx-ref" });
    expect(calls()).toEqual([
      `https://cloudt.kushkipagos.com/terminal/v1/${SERIAL}/sync/charge`,
      `https://cloudt.kushkipagos.com/terminal/v1/${SERIAL}/sync/transaction_search_online`,
      `https://cloudt.kushkipagos.com/terminal/v1/${SERIAL}/sync/transaction_search_online`,
    ]);
    // La búsqueda va firmada y cifrada, filtrando por el mismo id con el
    // que se empujó el cobro (guardado en el reclamo ANTES de llamar).
    const [, init] = h.fetch.mock.calls[1];
    const ts = Number((init.headers as Record<string, string>).timestamp);
    const body = JSON.parse(decryptData(JSON.parse(init.body as string).data, ts, tokenPassword(`bc-test${SERIAL}`, ts)));
    expect(body).toEqual({
      page: 1,
      size: 20,
      filters: { client_transaction_id: claim()!.clientTransactionId, start_date: 0, end_date: 0 },
    });
    const [, chargeInit] = h.fetch.mock.calls[0];
    const chargeTs = Number((chargeInit.headers as Record<string, string>).timestamp);
    const chargeBody = JSON.parse(
      decryptData(JSON.parse(chargeInit.body as string).data, chargeTs, tokenPassword(`bc-test${SERIAL}`, chargeTs)),
    );
    expect(chargeBody.client_transaction_id).toBe(claim()!.clientTransactionId);

    // Salda por el camino del aprobado: pago, reclamo, orden, ledger.
    expect(h.fake.payment(PAYMENT_ID)).toMatchObject({ status: "approved", reconciliationRequired: false, providerRef: "8c1d2f1e-tx-ref" });
    expect(claim()).toMatchObject({ status: "completed", checkStatus: "approved", checkedAt: expect.any(Date) });
    expect(h.fake.order().status).toBe("paid");
    expect(h.fake.state.kushkiTransactions).toEqual([
      expect.objectContaining({ kushkiTxId: "8c1d2f1e-tx-ref", status: "approved", approvalCode: "482913" }),
    ]);
    expect(h.events).toEqual([expect.objectContaining({ eventId: `cloudterm:${PAYMENT_ID}:ok`, type: "terminal.approved" })]);
    // Factura: la misma llamada que settle-cash (tirilla → DIAN → impresión).
    expect(h.issueInvoice).toHaveBeenCalledOnce();
    expect(h.issueInvoice).toHaveBeenCalledWith({ tenantId: "rest-1", orderId: ORDER_ID });
    expect(h.publish).toHaveBeenCalledWith("rest-1", { type: "order.paid", orderId: ORDER_ID });
  });

  it("el aprobado síncrono de siempre también termina en la factura", async () => {
    h.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ approved: true, rawResponse: { transaction_reference: "tx-sync", authorized_amount: TOTAL / 100 } }), { status: 200 }),
    );
    expect(await charge()).toMatchObject({ status: 200, json: { status: "approved" } });
    expect(searchCalls()).toHaveLength(0);
    expect(h.issueInvoice).toHaveBeenCalledWith({ tenantId: "rest-1", orderId: ORDER_ID });
  });

  it("un timeout propio (AbortError) también busca el resultado", async () => {
    h.fetch.mockRejectedValueOnce(Object.assign(new Error("aborted"), { name: "AbortError" }));
    searchSays(() => [sale()]);
    expect(await charge()).toMatchObject({ status: 200, json: { status: "approved", recovered: true } });
  });
});

describe("terminal/charge: 504 del gateway y el banco rechazó", () => {
  it("la venta aparece DECLINED → se declina y la cuenta queda libre", async () => {
    html504();
    searchSays(() => [sale({ transaction_status: "DECLINED", approved_transaction_amount: 0 })]);

    const { status, json } = await charge();

    expect(status).toBe(402);
    expect(json).toMatchObject({ ok: false, status: "declined", recovered: true });
    expect(h.fake.payment(PAYMENT_ID)).toMatchObject({ status: "declined", reconciliationRequired: false });
    expect(claim()).toMatchObject({ status: "failed" });
    expect(h.fake.order().status).toBe("served");
    expect(h.issueInvoice).not.toHaveBeenCalled();
  });
});

describe("terminal/charge: 504 y Kushki no sabe nada → incierto como antes", () => {
  it("consulta cada 10 s hasta el final de la ventana y deja el pago incierto", async () => {
    html504();
    h.fetch.mockImplementation(async () => new Response(JSON.stringify({ items: [] }), { status: 200 }));

    const { status, json } = await charge();

    expect(status).toBe(202);
    expect(json).toEqual({ pending: true, error: "payment_pending" });
    // La primera enseguida y una cada 10 s mientras quepa en la ventana.
    expect(searchCalls()).toHaveLength(Math.floor(TERMINAL_RECOVERY_WINDOW_MS / TERMINAL_RECOVERY_INTERVAL_MS) + 1);
    expect(h.fake.payment(PAYMENT_ID)).toMatchObject({ status: "pending", reconciliationRequired: true });
    expect(claim()).toMatchObject({ status: "pending", answeredAt: null, checkStatus: "not_found" });
    expect(h.issueInvoice).not.toHaveBeenCalled();
  });

  it("si la consulta misma falla, sigue intentando y al final queda incierto", async () => {
    html504();
    h.fetch.mockImplementation(async () => new Response("<html>502</html>", { status: 502 }));
    expect((await charge()).status).toBe(202);
    expect(claim()).toMatchObject({ checkStatus: "error" });
    expect(h.fake.payment(PAYMENT_ID)).toMatchObject({ status: "pending", reconciliationRequired: true });
  });

  it.each([
    ["una reversión del mismo cobro", [{ transaction_type: "SALE" }, { transaction_type: "REVERSE", transaction_status: "APPROVAL" }], "unknown:reversed"],
    ["un aprobado por OTRO monto", [{ approved_transaction_amount: 9_185_000 }], "unknown:amount_mismatch"],
  ])("%s → no se decide solo: incierto de inmediato, sin más consultas", async (_label, overrides, checkStatus) => {
    html504();
    h.fetch.mockImplementationOnce(async () =>
      new Response(JSON.stringify({ items: (overrides as Record<string, unknown>[]).map((o) => sale(o)) }), { status: 200 }),
    );
    expect((await charge()).status).toBe(202);
    expect(searchCalls()).toHaveLength(1);
    expect(claim()).toMatchObject({ checkStatus });
    expect(h.fake.payment(PAYMENT_ID)).toMatchObject({ status: "pending", reconciliationRequired: true });
  });

  it("si mientras tanto alguien lo resolvió, deja de consultar", async () => {
    html504();
    h.fetch.mockImplementationOnce(async () => {
      // Otro proceso declina el pago justo después de la primera consulta.
      queueMicrotask(() => {
        const p = h.fake.payment(PAYMENT_ID)!;
        p.status = "declined";
      });
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    });
    await charge();
    expect(searchCalls()).toHaveLength(1);
  });
});
