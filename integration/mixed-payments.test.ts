import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/lib/db";
import { POST as payCash } from "../src/app/api/tenant/[slug]/pay/route";
import { POST as requestTerminal } from "../src/app/api/tenant/[slug]/pay/external-terminal-request/route";
import { POST as settleTerminal } from "../src/app/api/operator/payments/[id]/settle-external-terminal/route";
import { computeOpenShiftMetrics } from "../src/lib/shift";
import { buildCashSnapshot } from "../src/lib/cashBox";

const scope = vi.hoisted(() => ({ restaurantId: "", userId: "", role: "operator", loggedIn: true }));
vi.mock("../src/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("../src/auth", () => ({ auth: async () => scope.loggedIn ? { user: { id: scope.userId, role: scope.role, restaurantId: scope.restaurantId } } : null }));
vi.mock("../src/lib/activeRestaurant", () => ({
  getActiveRestaurantId: async () => scope.restaurantId,
  getActiveContext: async () => scope.loggedIn ? { restaurantId: scope.restaurantId, session: { user: { id: scope.userId, role: scope.role } } } : null,
}));
// The database and invoice snapshot stay real; outbound effects stay local.
vi.mock("../src/lib/events", () => ({ publishOrderEvent: vi.fn() }));
vi.mock("../src/lib/mailer", () => ({ welcomeIfFirstTime: vi.fn(async () => undefined), sendEmail: vi.fn() }));
vi.mock("../src/lib/invoiceDelivery", () => ({ deliverInvoiceEmail: vi.fn(async () => undefined) }));
vi.mock("../src/lib/print/invoiceQueue", () => ({ enqueueInvoicePrintSafe: vi.fn(async () => undefined) }));
vi.mock("../src/lib/kds/autoFireTickets", () => ({ notifyAutoFiredTickets: vi.fn(async () => undefined) }));
vi.mock("../src/lib/push", () => ({ sendPushToMeserosForTable: vi.fn(async () => undefined) }));
vi.mock("../src/lib/billRequest", () => ({ announceBillRequestedOnPay: vi.fn(async () => undefined) }));

const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["localhost", "127.0.0.1"].includes(database.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname)) {
  throw new Error("Isolated local database required");
}
const tenants: string[] = [];
let slug: string;
let tableId: string;
const request = (body: unknown, key?: string) => new Request("http://localhost/api/test", {
  method: "POST", headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) }, body: JSON.stringify(body),
});
const tenantParams = () => ({ params: Promise.resolve({ slug }) });
const cash = (orderId: string, amountCents: number, tipCents = 0, key = randomUUID()) => payCash(
  request({ orderId, method: "cash", amountCents, tipCents, settleNow: true }, key), tenantParams(),
);
const terminal = (orderId: string, amountCents: number, tipCents = 0) => requestTerminal(request({ orderId, amountCents, tipCents }), tenantParams());
const settle = (id: string, action: "approve" | "decline" = "approve") => settleTerminal(request({ action }), { params: Promise.resolve({ id }) });
async function account(subtotalCents = 10800, taxCents = 0, discountCents = 0) {
  return db.order.create({ data: {
    restaurantId: scope.restaurantId, tableId, shortCode: randomUUID(), status: "placed",
    subtotalCents, taxCents, discountCents, totalCents: subtotalCents + taxCents - discountCents,
    simpleInvoiceEmail: "", items: { create: { nameSnapshot: "Mixed payment fixture", priceCentsSnapshot: subtotalCents, ...(taxCents ? { taxKind: "iva", taxPct: 19 } : {}) } },
  } });
}
async function createTenant() {
  const tenant = await db.restaurant.create({ data: { name: "Mixed payment fixture", slug: `mixed-${randomUUID()}`, salesTaxKind: "inc", salesTaxPct: 8, enabledModules: [] } });
  tenants.push(tenant.id);
  const user = await db.user.create({ data: { restaurantId: tenant.id, role: "operator", email: `${randomUUID()}@example.test`, passwordHash: "test-only" } });
  const table = await db.table.create({ data: { restaurantId: tenant.id, number: 1, qrToken: randomUUID() } });
  return { tenant, user, table };
}
beforeEach(async () => {
  const fixture = await createTenant();
  scope.restaurantId = fixture.tenant.id; scope.userId = fixture.user.id; scope.role = "operator"; scope.loggedIn = true;
  slug = fixture.tenant.slug; tableId = fixture.table.id;
});
afterAll(async () => {
  try { await db.restaurant.deleteMany({ where: { id: { in: tenants } } }); }
  finally { await db.$disconnect(); }
});

describe("sequential mixed payments on PostgreSQL", () => {
  it("keeps partial cash open, requires POS confirmation and issues one complete invoice", async () => {
    const order = await account();
    const shift = await db.shift.create({ data: { restaurantId: scope.restaurantId, openedById: scope.userId, openingCashCents: 1000, openedAt: new Date(Date.now() - 60_000) } });
    const firstKey = randomUUID();
    const first = await cash(order.id, 3300, 300, firstKey);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ paid: false, pending: false });
    expect(await db.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: "paying", paidAt: null, tipCents: 300 });
    expect(await db.simpleInvoice.count({ where: { orderId: order.id } })).toBe(0);

    const pending = await terminal(order.id, 8580, 780).then(r => r.json());
    const duplicate = await terminal(order.id, 8580, 780).then(r => r.json());
    expect(duplicate.paymentId).toBe(pending.paymentId);
    expect(await db.payment.findUniqueOrThrow({ where: { id: pending.paymentId } })).toMatchObject({ status: "pending", method: "external_terminal" });
    expect(await db.simpleInvoice.count({ where: { orderId: order.id } })).toBe(0);
    expect(await computeOpenShiftMetrics(scope.restaurantId, shift)).toMatchObject({ cashCents: 3300, grossCents: 3300, payments: 1 });

    const completed = await settle(pending.paymentId);
    expect(completed.status).toBe(200);
    const response = await completed.json();
    expect(response).toMatchObject({ paid: true, status: "approved" });
    expect(response.invoiceId).toBeTruthy();
    const closed = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(closed).toMatchObject({ status: "paid", totalCents: 11880, tipCents: 1080 });
    expect(closed.paidAt).toBeInstanceOf(Date);
    expect(await db.simpleInvoice.findUniqueOrThrow({ where: { orderId: order.id } })).toMatchObject({ totalCents: 11880, snapshot: { subtotalCents: 10800, totalCents: 11880, tipCents: 1080, embeddedTaxCents: 800 } });
    expect(await computeOpenShiftMetrics(scope.restaurantId, shift)).toMatchObject({ cashCents: 3300, grossCents: 11880, tipCents: 1080, consumptionTaxCents: 800, payments: 2, ordersClosed: 1, byMethod: [
      { method: "external_terminal", count: 1, sumCents: 8580 }, { method: "cash", count: 1, sumCents: 3300 },
    ] });
    expect(await buildCashSnapshot(scope.restaurantId, "global")).toMatchObject({ consolidatedCents: 4300, general: { collectedCashCents: 3300 } });

    expect((await settle(pending.paymentId)).status).toBe(409);
    expect((await cash(order.id, 3300, 300, firstKey)).status).toBe(200);
    expect(await db.payment.count({ where: { orderId: order.id, status: "approved" } })).toBe(2);
    expect(await db.simpleInvoice.count({ where: { orderId: order.id } })).toBe(1);
    expect((await db.restaurant.findUniqueOrThrow({ where: { id: scope.restaurantId } })).invoiceNextNumber).toBe(2);
  });

  it("also closes when POS is paid first and the remainder is cash", async () => {
    const order = await account();
    const pending = await terminal(order.id, 6600, 600).then(r => r.json());
    expect(await settle(pending.paymentId).then(r => r.json())).toMatchObject({ paid: false, invoiceId: null });
    expect(await db.simpleInvoice.count({ where: { orderId: order.id } })).toBe(0);
    expect(await cash(order.id, 5280, 480).then(r => r.json())).toMatchObject({ paid: true });
    expect(await db.simpleInvoice.count({ where: { orderId: order.id } })).toBe(1);
  });

  it("declining a POS part preserves the cash and lets only its remainder be paid again", async () => {
    const order = await account();
    await cash(order.id, 3300, 300);
    const pending = await terminal(order.id, 8580, 780).then(r => r.json());
    expect(await settle(pending.paymentId, "decline").then(r => r.json())).toEqual({ ok: true, status: "declined" });
    expect(await db.payment.findMany({ where: { orderId: order.id, status: "approved" } })).toHaveLength(1);
    expect(await db.simpleInvoice.count({ where: { orderId: order.id } })).toBe(0);
    expect(await cash(order.id, 8580, 780).then(r => r.json())).toMatchObject({ paid: true });
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).tipCents).toBe(1080);
  });

  it("deduplicates concurrent cash retries and rejects a changed amount under the same key", async () => {
    const order = await account(); const key = randomUUID();
    const results = await Promise.all([cash(order.id, 3300, 300, key), cash(order.id, 3300, 300, key)]);
    const payloads = await Promise.all(results.map(r => r.json()));
    expect(payloads[0].paymentId).toBe(payloads[1].paymentId);
    expect(await db.payment.count({ where: { orderId: order.id } })).toBe(1);
    await expect(cash(order.id, 4400, 400, key)).rejects.toThrow("operation_conflict");
  });

  it("serializes overlapping partial charges so their food cannot exceed the bill", async () => {
    const order = await account();
    const results = await Promise.allSettled([cash(order.id, 8800, 800), cash(order.id, 8800, 800)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.payment.count({ where: { orderId: order.id } })).toBe(1);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("paying");
  });

  it("reserves a real payment in flight instead of cancelling it for the next cash part", async () => {
    const order = await account();
    await cash(order.id, 3300, 300);
    const inFlight = await db.payment.create({ data: { orderId: order.id, method: "kushki_card", status: "pending", amountCents: 8580, tipCents: 780 } });
    await expect(cash(order.id, 8580, 780)).rejects.toThrow("pending_payment_in_flight");
    expect((await db.payment.findUniqueOrThrow({ where: { id: inFlight.id } })).status).toBe("pending");
    expect(await db.payment.count({ where: { orderId: order.id } })).toBe(2);
    expect(await db.simpleInvoice.count({ where: { orderId: order.id } })).toBe(0);
  });

  it("includes added tax and discount in the exact remainder without changing either", async () => {
    const order = await account(10000, 1900, 1000);
    await cash(order.id, 5500, 500);
    const pending = await terminal(order.id, 6490, 590).then(r => r.json());
    expect(await settle(pending.paymentId).then(r => r.json())).toMatchObject({ paid: true });
    expect(await db.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ subtotalCents: 10000, taxCents: 1900, discountCents: 1000, tipCents: 1090, totalCents: 11990 });
  });

  it("does not overwrite a concurrently settled POS payment with a decline", async () => {
    const order = await account();
    await cash(order.id, 3300, 300);
    const pending = await terminal(order.id, 8580, 780).then(r => r.json());
    const results = await Promise.allSettled([settle(pending.paymentId), settle(pending.paymentId, "decline")]);
    const successful = results.filter(r => r.status === "fulfilled" && r.value.ok);
    expect(successful).toHaveLength(1);
    const payment = await db.payment.findUniqueOrThrow({ where: { id: pending.paymentId } });
    const closed = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(closed.status).toBe(payment.status === "approved" ? "paid" : "paying");
    expect(await db.simpleInvoice.count({ where: { orderId: order.id } })).toBe(payment.status === "approved" ? 1 : 0);
  });

  it("keeps a counter round inactive until the final part is approved", async () => {
    const order = await account();
    const round = await db.round.create({ data: { orderId: order.id, seq: 1, status: "open" } });
    await cash(order.id, 3300, 300);
    expect((await db.round.findUniqueOrThrow({ where: { id: round.id } })).status).toBe("open");
    const pending = await terminal(order.id, 8580, 780).then(r => r.json());
    expect((await db.round.findUniqueOrThrow({ where: { id: round.id } })).status).toBe("open");
    await settle(pending.paymentId);
    expect((await db.round.findUniqueOrThrow({ where: { id: round.id } })).status).toBe("placed");
  });

  it("enforces staff, tenant, admin-only and waiter-shift rules for partial payments", async () => {
    const order = await account();
    const pending = await terminal(order.id, 3300, 300).then(r => r.json());
    scope.loggedIn = false;
    expect((await cash(order.id, 3300, 300)).status).toBe(403);
    expect((await settle(pending.paymentId)).status).toBe(401);
    scope.loggedIn = true; scope.role = "kitchen";
    expect((await cash(order.id, 3300, 300)).status).toBe(403);
    expect((await settle(pending.paymentId)).status).toBe(401);
    scope.role = "operator";
    const other = await createTenant();
    const originalTenant = scope.restaurantId; scope.restaurantId = other.tenant.id;
    expect((await cash(order.id, 3300, 300)).status).toBe(403);
    expect((await settle(pending.paymentId)).status).toBe(403);
    scope.restaurantId = originalTenant;
    const waiter = await db.user.create({ data: { restaurantId: scope.restaurantId, role: "mesero", email: `${randomUUID()}@example.test`, passwordHash: "test-only" } });
    scope.userId = waiter.id; scope.role = "mesero";
    await db.restaurant.update({ where: { id: scope.restaurantId }, data: { adminOnlyCharge: true } });
    expect((await cash(order.id, 3300, 300)).status).toBe(403);
    expect((await settle(pending.paymentId)).status).toBe(403);
    await db.restaurant.update({ where: { id: scope.restaurantId }, data: { adminOnlyCharge: false, shiftPolicy: "by_waiter" } });
    expect((await cash(order.id, 3300, 300)).status).toBe(409);
    expect((await settle(pending.paymentId)).status).toBe(409);
    expect((await settle(pending.paymentId, "decline")).status).toBe(409);
    await db.shift.create({ data: { restaurantId: scope.restaurantId, userId: waiter.id, openedById: waiter.id, openingCashCents: 0 } });
    expect((await settle(pending.paymentId)).status).toBe(200);
    expect(await db.payment.findUniqueOrThrow({ where: { id: pending.paymentId } })).toMatchObject({ status: "approved" });
  });
});
