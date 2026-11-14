import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePaymentsDb } from "@/test/fakePaymentsDb";

/**
 * Producción, 2026-11-13: MESAPAY mandó $5.520 al datáfono y Kushki contestó
 * APROBADO (`approved: true`, `responseCode: "00"`) con `authorized_amount:
 * 5525`. El voucher salió y el dinero se cobró, pero el pago quedó «sin
 * respuesta» y la cuenta bloqueada porque cualquier diferencia se trataba
 * como incierta.
 *
 * Ahora un aprobado inequívoco se liquida por lo AUTORIZADO:
 *   - de más (dentro del tope) → propina cobrada en el datáfono;
 *   - de menos → parcial, el saldo queda pendiente;
 *   - sobre el tope, ×100 / ÷100, sin código de aprobación → a conciliar
 *     con «monto cobrado distinto» (nunca «sin respuesta»).
 *
 * Ruta real, cliente del Cloud Terminal real, recuperación real y procesador
 * del webhook real, contra la base en memoria. Kushki NUNCA se llama: `fetch`
 * es un doble con respuestas como la real (sin datos de tarjeta).
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
  slug: "demo",
  country: "CO",
  adminOnlyCharge: false,
  suspended: false,
  enabledPaymentMethods: ["cash", "kushki_card_terminal"],
  kushkiMode: "production",
  cloudTerminalBusinessCode: "bc-test",
};
const SERIAL = "SERIAL-TEST-0001";
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
    financialOperation: {
      updateMany: (a: never) => h.fake.tx.financialOperation.updateMany(a),
      findUnique: (a: never) => h.fake.tx.financialOperation.findUnique(a),
    },
    kushkiTransaction: { updateMany: (a: never) => h.fake.tx.kushkiTransaction.updateMany(a) },
    auditEvent: { create: (a: never) => h.fake.tx.auditEvent.create(a) },
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
import { checkTerminalChargeOnce, recoveryClock } from "@/lib/payments/terminalRecovery";

const ORDER_ID = "order-7";
const PAYMENT_ID = "pay-terminal-1";
const TOTAL = 552_000; // $5.520, como el caso real

const realClock = { ...recoveryClock };
let clock = 0;

function seed(total = TOTAL, tip = 0) {
  h.events = [];
  h.fake = createFakePaymentsDb({
    order: { id: ORDER_ID, status: "paying", subtotalCents: total - tip },
    payments: [{ id: PAYMENT_ID, method: "kushki_card_terminal", status: "pending", amountCents: total, tipCents: tip }],
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

/** La respuesta aprobada del Cloud Terminal, con la forma de la real. */
const approvedSays = (authorizedPesos: number, over: Record<string, unknown> = {}) =>
  h.fetch.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        approved: true,
        rawResponse: {
          hostRespond: true,
          approved: true,
          responseCode: "00",
          code: "000",
          transaction_reference: "tx-ref-1",
          authorized_amount: authorizedPesos,
          amount: 0,
          ...over,
        },
      }),
      { status: 200 },
    ),
  );
const searchSays = (items: () => unknown[]) =>
  h.fetch.mockImplementationOnce(async () => new Response(JSON.stringify({ items: items() }), { status: 200 }));
const sale = (over: Record<string, unknown> = {}) => ({
  transaction_reference: "tx-ref-1",
  client_transaction_id: claim()?.clientTransactionId,
  transaction_type: "SALE",
  transaction_status: "APPROVAL",
  approval_code: "482913",
  approved_transaction_amount: TOTAL / 100,
  ...over,
});
const html504 = () => h.fetch.mockResolvedValueOnce(new Response("<html>504 Gateway Time-out</html>", { status: 504 }));

const claim = () => h.fake.state.financialOperations.find((o) => o.key === `terminal:${PAYMENT_ID}`) as
  | (Record<string, unknown> & { clientTransactionId?: string | null })
  | undefined;
const searchCalls = () => h.fetch.mock.calls.map((c) => String(c[0])).filter((u) => u.endsWith("/sync/transaction_search_online"));
const audits = (kind: string) => h.fake.state.auditEvents.filter((a) => a.kind === kind);

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

describe("terminal/charge: el datáfono aprobó MÁS que la cuenta", () => {
  it("el caso real: mandó 5520, autorizó 5525 → aprobado, $5 de propina, cuenta pagada y marcada para revisión (sin bloquear)", async () => {
    approvedSays(5525);

    const { status, json } = await charge();

    expect(status).toBe(200);
    expect(json).toMatchObject({
      ok: true,
      status: "approved",
      adjustment: { check: "tip", expectedCents: 552_000, authorizedCents: 552_500, diffCents: 500 },
    });
    // Nunca «sin respuesta»: no se buscó nada y el pago quedó aprobado.
    expect(searchCalls()).toHaveLength(0);
    expect(h.fake.payment(PAYMENT_ID)).toMatchObject({
      status: "approved",
      amountCents: 552_500,
      tipCents: 500,
      reconciliationRequired: true,
      providerRef: "tx-ref-1",
    });
    // La orden: la propina es la suma de las propinas aprobadas → «Propina
    // voluntaria» y el total real en la factura.
    expect(h.fake.order()).toMatchObject({ status: "paid", tipCents: 500, totalCents: 552_500 });
    expect(claim()).toMatchObject({ status: "completed", authorizedCents: 552_500, amountCheck: "tip" });
    expect(h.fake.state.kushkiTransactions).toEqual([
      expect.objectContaining({ kushkiTxId: "tx-ref-1", status: "approved", amountCents: 552_500 }),
    ]);
    expect(audits("payment.terminal_amount_adjusted")).toEqual([
      expect.objectContaining({
        actorRole: "system",
        targetId: PAYMENT_ID,
        diff: expect.objectContaining({ expectedCents: 552_000, authorizedCents: 552_500, diffCents: 500, check: "tip", source: "sync_charge" }),
      }),
    ]);
    expect(h.issueInvoice).toHaveBeenCalledWith({ tenantId: "rest-1", orderId: ORDER_ID });
    expect(h.publish).toHaveBeenCalledWith("rest-1", { type: "order.paid", orderId: ORDER_ID });
  });

  it("la propina del datáfono se SUMA a la que el comensal ya eligió", async () => {
    seed(1_100_000, 100_000);
    approvedSays(11_500);
    expect((await charge()).status).toBe(200);
    expect(h.fake.payment(PAYMENT_ID)).toMatchObject({ amountCents: 1_150_000, tipCents: 150_000 });
    expect(h.fake.order()).toMatchObject({ status: "paid", tipCents: 150_000 });
  });

  it("una diferencia grande (sobre el 30 %) → NO se liquida: queda a conciliar con «monto cobrado distinto», sin buscar", async () => {
    approvedSays(7_500);

    const { status, json } = await charge();

    expect(status).toBe(202);
    expect(json).toEqual({ pending: true, error: "payment_pending", terminal: "amount_mismatch" });
    expect(searchCalls()).toHaveLength(0);
    expect(h.fake.payment(PAYMENT_ID)).toMatchObject({ status: "pending", amountCents: TOTAL, tipCents: 0, reconciliationRequired: true });
    expect(claim()).toMatchObject({ authorizedCents: 750_000, amountCheck: "over_cap", answeredAt: null });
    expect(audits("payment.terminal_amount_mismatch")).toEqual([
      expect.objectContaining({ diff: expect.objectContaining({ expectedCents: TOTAL, authorizedCents: 750_000, reason: "over_cap" }) }),
    ]);
    expect(h.events).toHaveLength(0);
    expect(h.issueInvoice).not.toHaveBeenCalled();
  });

  it("una diferencia sin código de aprobación ni responseCode 00 → a conciliar (unconfirmed), no propina", async () => {
    h.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ approved: true, rawResponse: { transaction_reference: "tx-ref-1", authorized_amount: 5525 } }), { status: 200 }),
    );
    expect(await charge()).toMatchObject({ status: 202, json: { terminal: "amount_mismatch" } });
    expect(claim()).toMatchObject({ authorizedCents: 552_500, amountCheck: "unconfirmed" });
    expect(h.fake.payment(PAYMENT_ID)).toMatchObject({ status: "pending", reconciliationRequired: true });
  });
});

describe("terminal/charge: el datáfono aprobó MENOS que la cuenta (parcial)", () => {
  it("se aprueba por lo autorizado y el saldo queda pendiente en la cuenta", async () => {
    seed(1_100_000, 100_000);
    approvedSays(8_000);

    const { status, json } = await charge();

    expect(status).toBe(200);
    expect(json).toMatchObject({ status: "approved", adjustment: { check: "partial", expectedCents: 1_100_000, authorizedCents: 800_000, diffCents: 300_000 } });
    // Se conserva la propina elegida; falta comida.
    expect(h.fake.payment(PAYMENT_ID)).toMatchObject({ status: "approved", amountCents: 800_000, tipCents: 100_000, reconciliationRequired: true });
    expect(h.fake.order().status).toBe("paying");
    expect(claim()).toMatchObject({ amountCheck: "partial", authorizedCents: 800_000 });
    expect(h.issueInvoice).not.toHaveBeenCalled();
  });
});

describe("terminal/charge: error de unidades (pesos ↔ centavos)", () => {
  it.each([
    ["×100", 552_000],
    ["÷100", 55.2],
  ])("%s → a conciliar como unidades, nunca propina ni parcial", async (_label, authorizedPesos) => {
    approvedSays(authorizedPesos);
    expect(await charge()).toMatchObject({ status: 202, json: { terminal: "amount_mismatch" } });
    expect(claim()).toMatchObject({ amountCheck: "units" });
    expect(h.fake.payment(PAYMENT_ID)).toMatchObject({ status: "pending", amountCents: TOTAL, tipCents: 0, reconciliationRequired: true });
  });
});

describe("terminal/charge: la búsqueda posterior (504) también liquida por lo autorizado", () => {
  it("confirma el monto de la cuenta → aprobado igual que siempre", async () => {
    html504();
    searchSays(() => [sale()]);
    const { status, json } = await charge();
    expect(status).toBe(200);
    expect(json).toMatchObject({ status: "approved", recovered: true });
    expect(json.adjustment).toBeUndefined();
    expect(h.fake.payment(PAYMENT_ID)).toMatchObject({ status: "approved", amountCents: TOTAL, tipCents: 0, reconciliationRequired: false });
    expect(claim()).toMatchObject({ checkStatus: "approved" });
    expect(claim()?.amountCheck ?? null).toBeNull();
  });

  it("encuentra la venta por $5 más (con código de aprobación) → propina", async () => {
    html504();
    searchSays(() => [sale({ approved_transaction_amount: 5525 })]);
    const { status, json } = await charge();
    expect(status).toBe(200);
    expect(json).toMatchObject({ status: "approved", recovered: true, adjustment: { check: "tip", diffCents: 500 } });
    expect(h.fake.payment(PAYMENT_ID)).toMatchObject({ status: "approved", amountCents: 552_500, tipCents: 500 });
    expect(audits("payment.terminal_amount_adjusted")[0]?.diff).toMatchObject({ source: "transaction_search_online", approvalCode: "482913" });
  });

  it("encuentra la venta ×100 → incierto con «monto cobrado distinto», sin más consultas", async () => {
    html504();
    searchSays(() => [sale({ approved_transaction_amount: 552_000 })]);
    expect(await charge()).toMatchObject({ status: 202, json: { terminal: "amount_mismatch" } });
    expect(searchCalls()).toHaveLength(1);
    expect(claim()).toMatchObject({ checkStatus: "unknown:amount_mismatch", amountCheck: "units" });
  });
});

describe("idempotencia: llegan la respuesta del cobro y la búsqueda", () => {
  it("la propina se registra UNA vez aunque «Consultar en Kushki» encuentre la misma venta después", async () => {
    approvedSays(5525);
    expect((await charge()).status).toBe(200);
    searchSays(() => [sale({ approved_transaction_amount: 5525 })]);

    const check = await checkTerminalChargeOnce({
      restaurantId: "rest-1",
      paymentId: PAYMENT_ID,
      amountCents: TOTAL,
      serialNumber: SERIAL,
      clientTransactionId: claim()!.clientTransactionId!,
      businessCode: "bc-test",
      mode: "production",
    });

    expect(check).toMatchObject({ settled: "approved", adjustment: { check: "tip", diffCents: 500 } });
    expect(h.fake.payment(PAYMENT_ID)).toMatchObject({ amountCents: 552_500, tipCents: 500 });
    expect(h.fake.order()).toMatchObject({ tipCents: 500 });
    expect(h.fake.state.kushkiTransactions).toHaveLength(1);
    expect(audits("payment.terminal_amount_adjusted")).toHaveLength(1);
    expect(h.events.filter((e) => e.eventId === `cloudterm:${PAYMENT_ID}:ok`)).toHaveLength(1);
  });

  it("si la respuesta llegó exacta y la búsqueda dice otro monto, vale lo primero (no se ajusta dos veces)", async () => {
    approvedSays(5520);
    expect((await charge()).status).toBe(200);
    searchSays(() => [sale({ approved_transaction_amount: 5525 })]);
    const check = await checkTerminalChargeOnce({
      restaurantId: "rest-1",
      paymentId: PAYMENT_ID,
      amountCents: TOTAL,
      serialNumber: SERIAL,
      clientTransactionId: claim()!.clientTransactionId!,
      businessCode: "bc-test",
      mode: "production",
    });
    expect(check.settled).toBe("approved");
    expect(check.adjustment).toBeUndefined();
    expect(h.fake.payment(PAYMENT_ID)).toMatchObject({ amountCents: TOTAL, tipCents: 0, reconciliationRequired: false });
  });
});
