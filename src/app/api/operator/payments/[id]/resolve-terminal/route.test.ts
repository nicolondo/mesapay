import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePaymentsDb } from "@/test/fakePaymentsDb";

/**
 * "Resolver cobro": el datáfono Kushki SÍ recibió el cobro (reclamo
 * `terminal:<id>`) y el resultado nunca volvió. Pasados 3 minutos, el
 * administrador lo marca rechazado o aprobado con evidencia, por la misma
 * conciliación de Cobros (`reconcilePayment`). Ruta real con `secureApi`
 * real y la conciliación real, contra la base en memoria.
 */

const h = vi.hoisted(() => ({
  fake: null as unknown as ReturnType<typeof import("@/test/fakePaymentsDb").createFakePaymentsDb>,
  session: null as null | { user: { id: string; role: string; email: string } },
  activeRestaurantId: "rest-1",
  publish: vi.fn(),
  issueInvoice: vi.fn(async () => ({ status: "skipped" })),
}));

vi.mock("@/lib/db", () => ({
  db: {
    restaurant: { findUnique: vi.fn(async () => ({ id: "rest-1", suspended: false })) },
    $transaction: (cb: never) => h.fake.$transaction(cb),
  },
}));
vi.mock("@/auth", () => ({ auth: async () => h.session }));
vi.mock("@/lib/activeRestaurant", () => ({
  getActiveContext: async () => (h.session ? { restaurantId: h.activeRestaurantId, session: h.session } : null),
  getActiveRestaurantId: async () => h.activeRestaurantId,
}));
vi.mock("@/lib/rateLimit", () => ({ rateLimit: async () => true }));
vi.mock("@/lib/orderLock", () => ({ lockOrder: async () => {} }));
vi.mock("@/lib/events", () => ({ publishOrderEvent: h.publish }));
vi.mock("@/lib/invoiceOnPaid", () => ({ issueInvoiceOnPaid: h.issueInvoice }));
vi.mock("@/lib/prepaidRounds", () => ({ activateOpenRounds: async () => [] }));
vi.mock("@/lib/kds/autoFireTickets", () => ({ notifyAutoFiredTickets: async () => {} }));

import { POST } from "./route";

const ORDER_ID = "order-7";
const TOTAL = 17_457_000;
const TIP = 1_587_000;
const PUSHED_AT = new Date("2026-10-31T18:30:00Z");
const at = (ms: number) => new Date(PUSHED_AT.getTime() + ms);

function seed({
  pushed = true,
  payment = {},
}: { pushed?: boolean; payment?: Record<string, unknown> } = {}) {
  h.fake = createFakePaymentsDb({
    order: { id: ORDER_ID, status: "paying", subtotalCents: TOTAL - TIP },
    payments: [{ id: "smart", method: "kushki_card_terminal", status: "pending", amountCents: TOTAL, tipCents: TIP, ...payment }],
    financialOperations: pushed
      ? [{ key: "terminal:smart", paymentId: "smart", amountCents: TOTAL, createdAt: PUSHED_AT }]
      : [],
    rounds: [{ status: "served" }],
  });
}

async function resolve(body: Record<string, unknown>, paymentId = "smart") {
  const res = await POST(
    new Request(`http://localhost/api/operator/payments/${paymentId}/resolve-terminal`, {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: paymentId }) },
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const DECLINE = { outcome: "declined", evidence: "El datáfono mostró rechazada y no imprimió voucher", confirmed: true };
const APPROVE = {
  outcome: "approved",
  evidence: "El datáfono imprimió el voucher aprobado",
  confirmed: true,
  authorizationCode: "AUT-482913",
};
const ADMIN = { user: { id: "admin-1", role: "operator", email: "admin@sonymelona.co" } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at(3 * 60_000 + 1_000));
  h.session = ADMIN;
  h.activeRestaurantId = "rest-1";
});
afterEach(() => {
  vi.useRealTimers();
});

describe("resolve-terminal: No se cobró → rechazado", () => {
  it("declina el cobro, cierra el reclamo, libera la cuenta y deja la auditoría con el actor", async () => {
    seed();
    const { status, json } = await resolve(DECLINE);

    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, status: "declined", alreadyResolved: false });
    expect(h.fake.payment("smart")).toMatchObject({
      status: "declined",
      reconciliationRequired: false,
      providerRef: "manual:admin-1:smart",
    });
    expect(h.fake.state.financialOperations[0]).toMatchObject({ key: "terminal:smart", status: "failed" });
    // Sin nada pendiente ni aprobado, sale de `paying` como con un rechazo de Kushki.
    expect(h.fake.order().status).toBe("served");
    expect(h.fake.state.auditEvents).toEqual([
      expect.objectContaining({
        kind: "payment.reconciled",
        restaurantId: "rest-1",
        actorUserId: "admin-1",
        actorEmail: "admin@sonymelona.co",
        actorRole: "operator",
        targetId: "smart",
        summary: DECLINE.evidence,
        diff: expect.objectContaining({ outcome: "declined", manualTerminalResolution: true, authorizationCode: null }),
      }),
    ]);
    expect(h.publish).toHaveBeenCalledWith("rest-1", { type: "order.updated", orderId: ORDER_ID });
  });

  it("después de rechazarlo, la cuenta se puede cobrar en efectivo (el trigger lo deja)", async () => {
    seed();
    await resolve(DECLINE);
    await expect(
      h.fake.tx.payment.create({ data: { orderId: ORDER_ID, method: "cash", status: "approved", amountCents: TOTAL, tipCents: TIP } }),
    ).resolves.toMatchObject({ status: "approved" });
  });

  it("si ya estaba marcado incierto (reconciliationRequired), se resuelve igual", async () => {
    seed({ payment: { reconciliationRequired: true } });
    expect((await resolve(DECLINE)).status).toBe(200);
    expect(h.fake.payment("smart")).toMatchObject({ status: "declined", reconciliationRequired: false });
  });
});

describe("resolve-terminal: Sí se cobró → aprobado", () => {
  it("aprueba el cobro con el voucher, salda la cuenta y emite la factura como la conciliación", async () => {
    seed();
    const { status, json } = await resolve(APPROVE);

    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, status: "approved" });
    expect(h.fake.payment("smart")).toMatchObject({ status: "approved", reconciliationRequired: false });
    expect(h.fake.payment("smart")?.settledAt).toBeInstanceOf(Date);
    expect(h.fake.order()).toMatchObject({ status: "paid", tipCents: TIP, totalCents: TOTAL });
    expect(h.fake.state.financialOperations[0]).toMatchObject({ status: "completed" });
    expect(h.fake.state.kushkiTransactions).toEqual([
      expect.objectContaining({ kushkiTxId: "manual:admin-1:smart", paymentId: "smart", status: "approved", approvalCode: "AUT-482913" }),
    ]);
    expect(h.fake.state.auditEvents[0]).toMatchObject({
      kind: "payment.reconciled",
      actorUserId: "admin-1",
      diff: expect.objectContaining({ outcome: "approved", authorizationCode: "AUT-482913", manualTerminalResolution: true }),
    });
    expect(h.issueInvoice).toHaveBeenCalledWith({ tenantId: "rest-1", orderId: ORDER_ID });
  });

  it("un pago con referencia del proveedor conserva SU referencia (no la pisa con manual:)", async () => {
    seed({ payment: { providerRef: "mock-term-77" } });
    expect((await resolve(APPROVE)).status).toBe(200);
    expect(h.fake.payment("smart")?.providerRef).toBe("mock-term-77");
  });
});

describe("resolve-terminal: el umbral de 3 minutos", () => {
  it.each([0, 60_000, 2 * 60_000 + 59_000])("a los %i ms del envío → 409 terminal_result_pending y nada cambia", async (ms) => {
    seed();
    vi.setSystemTime(at(ms));
    const { status, json } = await resolve(DECLINE);
    expect(status).toBe(409);
    expect(json).toEqual({ error: "terminal_result_pending", resolvableAt: at(3 * 60_000).toISOString() });
    expect(h.fake.payment("smart")).toMatchObject({ status: "pending", reconciliationRequired: false });
    expect(h.fake.state.auditEvents).toHaveLength(0);
  });

  it("justo a los 3 minutos ya se puede", async () => {
    seed();
    vi.setSystemTime(at(3 * 60_000));
    expect((await resolve(DECLINE)).status).toBe(200);
  });
});

describe("resolve-terminal: evidencia y confirmación obligatorias", () => {
  it.each([
    ["sin nota", { outcome: "declined", confirmed: true }],
    ["nota muy corta", { ...DECLINE, evidence: "rechazo" }],
    ["nota de puros espacios", { ...DECLINE, evidence: "               " }],
    ["sin confirmación", { outcome: "declined", evidence: DECLINE.evidence }],
    ["confirmación en false", { ...DECLINE, confirmed: false }],
    ["aprobado sin número de autorización", { outcome: "approved", evidence: APPROVE.evidence, confirmed: true }],
    ["aprobado con autorización vacía", { ...APPROVE, authorizationCode: "  " }],
    ["un resultado que no existe", { ...DECLINE, outcome: "reviewed" }],
  ])("%s → 400 y nada cambia", async (_label, body) => {
    seed();
    const { status, json } = await resolve(body);
    expect(status).toBe(400);
    expect(json.error).toBe("invalid_payload");
    expect(h.fake.payment("smart")?.status).toBe("pending");
    expect(h.fake.state.auditEvents).toHaveLength(0);
  });
});

describe("resolve-terminal: quién puede", () => {
  it.each(["operator", "platform_admin", "group_admin"])("%s puede resolver", async (role) => {
    seed();
    h.session = { user: { id: `u-${role}`, role, email: `${role}@mesapay.co` } };
    expect((await resolve(DECLINE)).status).toBe(200);
  });

  it.each(["mesero", "terminal", "kitchen", "bar"])("%s NO puede (403) y nada cambia", async (role) => {
    seed();
    h.session = { user: { id: "u", role, email: "u@mesapay.co" } };
    expect(await resolve(DECLINE)).toMatchObject({ status: 403, json: { error: "forbidden" } });
    expect(h.fake.payment("smart")?.status).toBe("pending");
  });

  it("un pago de otro comercio → 403", async () => {
    seed();
    h.activeRestaurantId = "otro";
    expect((await resolve(DECLINE)).status).toBe(403);
    expect(h.fake.payment("smart")?.status).toBe("pending");
  });
});

describe("resolve-terminal: sólo para el datáfono Kushki enviado", () => {
  it("nunca se envió (sin reclamo) → 409 terminal_not_sent: se cancela, no se resuelve", async () => {
    seed({ pushed: false });
    expect(await resolve(DECLINE)).toMatchObject({ status: 409, json: { error: "terminal_not_sent" } });
    expect(h.fake.payment("smart")?.status).toBe("pending");
  });

  it.each(["kushki_pse", "kushki_card", "kushki_apple_pay"])("%s sigue yendo a Cobros → conciliación (400 wrong_method)", async (method) => {
    seed({ payment: { method } });
    expect(await resolve(DECLINE)).toMatchObject({ status: 400, json: { error: "wrong_method" } });
    expect(h.fake.payment("smart")?.status).toBe("pending");
  });

  it("ya resuelto → 409 already_settled", async () => {
    seed({ payment: { status: "approved" } });
    expect(await resolve(DECLINE)).toMatchObject({ status: 409, json: { error: "already_settled" } });
  });

  it("no existe → 404", async () => {
    seed();
    expect((await resolve(DECLINE, "nope")).status).toBe(404);
  });
});
