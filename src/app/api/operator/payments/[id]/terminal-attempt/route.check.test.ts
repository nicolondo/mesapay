import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePaymentsDb } from "@/test/fakePaymentsDb";

/**
 * «Consultar en Kushki» sobre un cobro del datáfono que se envió y no tuvo
 * respuesta: busca el resultado real (`transaction_search_online` por el
 * `client_transaction_id` del reclamo) y, si es definitivo, lo registra por
 * el mismo camino que la respuesta del datáfono (aprobado → cuenta saldada y
 * factura como en efectivo; rechazado → cuenta libre). Sin resultado no
 * cambia nada: sigue "Resolver cobro".
 *
 * Ruta real, recuperación real y procesador del webhook real contra la base
 * en memoria. Kushki NUNCA se llama: la búsqueda es un doble.
 */

const h = vi.hoisted(() => ({
  fake: null as unknown as ReturnType<typeof import("@/test/fakePaymentsDb").createFakePaymentsDb>,
  events: [] as Array<Record<string, unknown> & { id: string; eventId: string }>,
  session: null as null | { user: { id: string; role: string; email?: string; restaurantId?: string } },
  adminOnlyCharge: false,
  search: vi.fn(),
  publish: vi.fn(),
  issueInvoice: vi.fn(async () => ({ status: "issued" })),
}));

const TENANT = {
  id: "rest-1",
  slug: "sonymelona",
  suspended: false,
  kushkiMode: "production",
  cloudTerminalBusinessCode: "bc-test",
  get adminOnlyCharge() {
    return h.adminOnlyCharge;
  },
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
    payment: { findUnique: (a: never) => h.fake.tx.payment.findUnique(a) },
    financialOperation: {
      findUnique: (a: never) => h.fake.tx.financialOperation.findUnique(a),
      updateMany: (a: never) => h.fake.tx.financialOperation.updateMany(a),
    },
    kushkiTransaction: { updateMany: (a: never) => h.fake.tx.kushkiTransaction.updateMany(a) },
    auditEvent: { create: (a: never) => h.fake.tx.auditEvent.create(a) },
    terminalDevice: { findUnique: vi.fn(async () => DEVICE) },
    $transaction: (cb: never) => h.fake.$transaction(cb),
  },
}));
vi.mock("@/auth", () => ({ auth: async () => h.session }));
vi.mock("@/lib/activeRestaurant", () => ({
  getActiveContext: async () => (h.session ? { restaurantId: "rest-1", session: h.session } : null),
  getActiveRestaurantId: async () => "rest-1",
}));
vi.mock("@/lib/rateLimit", () => ({ rateLimit: async () => true }));
vi.mock("@/lib/orderLock", () => ({ lockOrder: async () => {} }));
vi.mock("@/lib/waiterCommissionsSeal", () => ({ sealOrderCommission: async () => {} }));
vi.mock("@/lib/events", () => ({ publishOrderEvent: h.publish }));
vi.mock("@/lib/invoiceOnPaid", () => ({ issueInvoiceOnPaid: h.issueInvoice }));
vi.mock("@/lib/prepaidRounds", () => ({ activateOpenRounds: async () => [] }));
vi.mock("@/lib/kds/autoFireTickets", () => ({ notifyAutoFiredTickets: async () => {} }));
vi.mock("@/lib/platformConfig", () => ({
  getRestaurantKushkiMode: async (r: { kushkiMode?: string | null }) => r.kushkiMode ?? "mock",
}));
vi.mock("@/lib/payments/kushki/cloudTerminal", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/payments/kushki/cloudTerminal")>()),
  searchCloudTerminalCharge: h.search,
  cancelCloudTerminalPayment: vi.fn(),
}));

import { POST } from "./route";

const ORDER_ID = "order-17";
const PAY = "smart-9";
const TOTAL = 9_185_000;
const TIP = 835_000;
const PUSHED_AT = new Date("2026-11-04T18:20:47Z");
const at = (ms: number) => new Date(PUSHED_AT.getTime() + ms);
const MESERO = { user: { id: "mesero-1", role: "mesero", email: "camila@sonymelona.co", restaurantId: "rest-1" } };

function seed({ clientTransactionId = "ctx-5c2a" as string | null } = {}) {
  h.events = [];
  h.fake = createFakePaymentsDb({
    order: { id: ORDER_ID, status: "paying", subtotalCents: TOTAL - TIP },
    payments: [{ id: PAY, method: "kushki_card_terminal", status: "pending", amountCents: TOTAL, tipCents: TIP, reconciliationRequired: true }],
    financialOperations: [
      { key: `terminal:${PAY}`, paymentId: PAY, amountCents: TOTAL, createdAt: PUSHED_AT, deviceId: "kd-1", clientTransactionId },
    ],
    rounds: [{ status: "served" }],
    extraTx: { kushkiWebhookEvent },
  });
}

async function check() {
  const res = await POST(
    new Request(`http://localhost/api/operator/payments/${PAY}/terminal-attempt`, {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ action: "check" }),
    }),
    { params: Promise.resolve({ id: PAY }) },
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const claim = () => h.fake.state.financialOperations[0];

beforeEach(() => {
  vi.clearAllMocks();
  h.search.mockReset();
  vi.stubEnv("DATABASE_URL", "postgresql://u:p@localhost:5432/test");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at(4 * 60_000));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  h.session = MESERO;
  h.adminOnlyCharge = false;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("«Consultar en Kushki»", () => {
  it("Kushki dice APROBADO: el mesero salda la cuenta y la factura sale como en efectivo", async () => {
    seed();
    h.search.mockResolvedValue({ status: "approved", transactionReference: "tx-77", approvalCode: "482913", raw: {} });

    const { status, json } = await check();

    expect(status).toBe(200);
    expect(json).toEqual({ ok: true, status: "approved" });
    expect(h.search).toHaveBeenCalledWith({
      serialNumber: "P3F6P624J0139",
      clientTransactionId: "ctx-5c2a",
      amountCents: TOTAL,
      businessCode: "bc-test",
      mode: "production",
    });
    expect(h.fake.payment(PAY)).toMatchObject({ status: "approved", reconciliationRequired: false, providerRef: "tx-77" });
    expect(h.fake.order().status).toBe("paid");
    expect(claim()).toMatchObject({ status: "completed", checkStatus: "approved" });
    expect(h.issueInvoice).toHaveBeenCalledWith({ tenantId: "rest-1", orderId: ORDER_ID });
    expect(h.fake.state.auditEvents).toEqual([
      expect.objectContaining({ kind: "payment.terminal_recovered", actorRole: "mesero", targetId: PAY }),
    ]);
  });

  it("Kushki dice RECHAZADO: la cuenta queda libre", async () => {
    seed();
    h.search.mockResolvedValue({ status: "declined", transactionReference: "tx-78", raw: {} });
    expect(await check()).toMatchObject({ status: 200, json: { status: "declined" } });
    expect(h.fake.payment(PAY)).toMatchObject({ status: "declined", reconciliationRequired: false });
    expect(h.fake.order().status).toBe("served");
    expect(h.issueInvoice).not.toHaveBeenCalled();
  });

  it("Kushki no registra el cobro: no cambia nada, y una segunda consulta enseguida no vuelve a llamar", async () => {
    seed();
    h.search.mockResolvedValue({ status: "not_found" });
    expect(await check()).toMatchObject({ status: 200, json: { status: "checked", result: "not_found" } });
    expect(h.fake.payment(PAY)).toMatchObject({ status: "pending", reconciliationRequired: true });
    expect(claim()).toMatchObject({ checkStatus: "not_found", checkedAt: expect.any(Date) });

    vi.setSystemTime(at(4 * 60_000 + 5_000));
    expect(await check()).toMatchObject({ status: 200, json: { status: "checked", result: "not_found", cached: true } });
    expect(h.search).toHaveBeenCalledOnce();
  });

  it("con «solo el administrador cobra» el mesero igual puede consultar (sólo lee el resultado)", async () => {
    seed();
    h.adminOnlyCharge = true;
    h.search.mockResolvedValue({ status: "not_found" });
    expect((await check()).status).toBe(200);
  });

  it("mientras el cobro está en curso no se ofrece: la ruta del cobro ya está consultando", async () => {
    seed();
    h.fake.payment(PAY)!.reconciliationRequired = false;
    vi.setSystemTime(at(70_000));
    expect(await check()).toMatchObject({ status: 409, json: { error: "terminal_result_pending" } });
    expect(h.search).not.toHaveBeenCalled();
  });

  it("un reclamo viejo, sin client_transaction_id, no se puede consultar", async () => {
    seed({ clientTransactionId: null });
    expect(await check()).toMatchObject({ status: 409, json: { error: "terminal_check_unavailable" } });
    expect(h.search).not.toHaveBeenCalled();
  });
});
