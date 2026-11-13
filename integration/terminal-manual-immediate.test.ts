import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/lib/db";
import { POST as resolveTerminal } from "../src/app/api/operator/payments/[id]/resolve-terminal/route";
import { processKushkiWebhook, type KushkiWebhookPayload } from "../src/lib/payments/webhookHandler";
import { manualTerminalRef } from "../src/lib/payments/terminalResolve";
import { recomputeOrderTotalsInTx } from "../src/lib/orderTotals";
import { issueInvoiceOnPaid } from "../src/lib/invoiceOnPaid";

const scope = vi.hoisted(() => ({ restaurantId: "", userId: "", role: "operator", loggedIn: true }));
vi.mock("../src/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("../src/lib/activeRestaurant", () => ({
  getActiveContext: async () => scope.loggedIn ? {
    restaurantId: scope.restaurantId,
    session: { user: { id: scope.userId, email: "manual-test@example.test", role: scope.role } },
  } : null,
}));
// Keep transactions, row locks, audit records and invoice snapshots real.
// Provider callbacks are synthetic; no email, print, charge or DIAN request leaves this test.
vi.mock("../src/lib/events", () => ({ publishOrderEvent: vi.fn() }));
vi.mock("../src/lib/mailer", () => ({ welcomeIfFirstTime: vi.fn(async () => undefined), sendEmail: vi.fn() }));
vi.mock("../src/lib/invoiceDelivery", () => ({ deliverInvoiceEmail: vi.fn(async () => undefined) }));
vi.mock("../src/lib/print/invoiceQueue", () => ({ enqueueInvoicePrintSafe: vi.fn(async () => undefined) }));
vi.mock("../src/lib/kds/autoFireTickets", () => ({ notifyAutoFiredTickets: vi.fn(async () => undefined) }));
vi.mock("../src/lib/push", () => ({ sendPushToMeserosForTable: vi.fn(async () => undefined) }));

const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["localhost", "127.0.0.1"].includes(database.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname)) {
  throw new Error("Terminal manual-resolution integration tests require an isolated local database");
}
const tenants: string[] = [];
const payments: string[] = [];
const webhookIds: string[] = [];
const evidence = "Revisé la pantalla del datáfono y confirmé el resultado físico.";
let tableId: string;

async function createTenant() {
  const tenant = await db.restaurant.create({ data: {
    name: "Manual terminal test", slug: `manual-terminal-${randomUUID()}`, enabledModules: [],
    salesTaxKind: "none", kitchenAutoFire: false, kitchenPrintEnabled: false,
    barPrintEnabled: false, invoiceAutoPrint: false,
  } });
  tenants.push(tenant.id);
  const user = await db.user.create({ data: {
    restaurantId: tenant.id, role: "operator", email: `${randomUUID()}@example.test`, passwordHash: "test-only",
  } });
  const table = await db.table.create({ data: { restaurantId: tenant.id, number: 1, qrToken: randomUUID() } });
  return { tenant, user, table };
}

async function sentPayment() {
  const order = await db.order.create({ data: {
    restaurantId: scope.restaurantId, tableId, shortCode: randomUUID(), status: "paying",
    subtotalCents: 100_000, totalCents: 100_000, simpleInvoiceEmail: "",
    items: { create: { nameSnapshot: "Synthetic product", priceCentsSnapshot: 100_000, qty: 1 } },
  } });
  const payment = await db.payment.create({ data: {
    orderId: order.id, method: "kushki_card_terminal", status: "pending", amountCents: 100_000,
  } });
  payments.push(payment.id);
  const claim = await db.financialOperation.create({ data: {
    key: `terminal:${payment.id}`, paymentId: payment.id, kind: "terminal", status: "pending",
    amountCents: payment.amountCents, clientTransactionId: randomUUID(), createdAt: new Date(Date.now() - 500),
  } });
  return { order, payment, claim };
}

function resolve(id: string, outcome: "approved" | "declined", extra: Record<string, unknown> = {}) {
  return resolveTerminal(new Request("http://localhost/api/test", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ outcome, evidence, confirmed: true, ...(outcome === "approved" ? { authorizationCode: "LOCAL-VOUCHER-123" } : {}), ...extra }),
  }), { params: Promise.resolve({ id }) });
}

function callback(fixture: Awaited<ReturnType<typeof sentPayment>>, approved: boolean, overrides: Partial<KushkiWebhookPayload> = {}) {
  const payload: KushkiWebhookPayload = {
    eventId: randomUUID(), type: approved ? "terminal.approved" : "terminal.declined",
    restaurantId: fixture.order.restaurantId, paymentId: fixture.payment.id, orderId: fixture.order.id,
    providerRef: `provider-${fixture.payment.id}`, amountCents: fixture.payment.amountCents, ...overrides,
  };
  webhookIds.push(payload.eventId);
  return payload;
}

beforeEach(async () => {
  const f = await createTenant();
  scope.restaurantId = f.tenant.id; scope.userId = f.user.id; scope.role = "operator"; scope.loggedIn = true;
  tableId = f.table.id;
});

afterAll(async () => {
  try {
    await db.kushkiWebhookEvent.deleteMany({ where: { eventId: { in: webhookIds } } });
    await db.financialOperation.deleteMany({ where: { paymentId: { in: payments } } });
    await db.restaurant.deleteMany({ where: { id: { in: tenants } } });
    await db.platformEvent.deleteMany({ where: { restaurantId: { in: tenants } } });
  } finally { await db.$disconnect(); }
});

describe("immediate terminal resolution on PostgreSQL", () => {
  it("releases a newly sent payment immediately and retains the signed manual decision", async () => {
    const f = await sentPayment();
    const result = await resolve(f.payment.id, "declined");
    expect(result.status).toBe(200);
    expect(Date.now() - f.claim.createdAt.getTime()).toBeLessThan(150_000);
    expect(await result.json()).toMatchObject({ ok: true, status: "declined", alreadyResolved: false });
    const reference = manualTerminalRef(scope.userId, f.payment.id);
    expect(await db.payment.findUniqueOrThrow({ where: { id: f.payment.id } })).toMatchObject({
      status: "declined", providerRef: reference, reconciliationRequired: false,
    });
    expect(await db.financialOperation.findUniqueOrThrow({ where: { key: f.claim.key } })).toMatchObject({ status: "failed" });
    expect(await db.order.findUniqueOrThrow({ where: { id: f.order.id } })).toMatchObject({ status: "open", paidAt: null });
    expect(await db.simpleInvoice.count({ where: { orderId: f.order.id } })).toBe(0);
    expect(await db.auditEvent.findFirstOrThrow({ where: { targetId: f.payment.id, kind: "payment.reconciled" } })).toMatchObject({
      actorUserId: scope.userId, actorRole: "operator", summary: evidence,
      diff: { manualTerminalResolution: true, outcome: "declined", providerRef: reference },
    });
  });

  it("requires a voucher to approve and serializes duplicate manual submissions into one invoice", async () => {
    const f = await sentPayment();
    expect((await resolve(f.payment.id, "approved", { authorizationCode: "" })).status).toBe(400);
    const responses = await Promise.all([resolve(f.payment.id, "approved"), resolve(f.payment.id, "approved")]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
    expect(await db.payment.findUniqueOrThrow({ where: { id: f.payment.id } })).toMatchObject({ status: "approved" });
    expect(await db.kushkiTransaction.findFirstOrThrow({ where: { paymentId: f.payment.id } })).toMatchObject({ approvalCode: "LOCAL-VOUCHER-123", status: "approved" });
    expect(await db.simpleInvoice.count({ where: { orderId: f.order.id } })).toBe(1);
    expect(await db.auditEvent.count({ where: { targetId: f.payment.id, kind: "payment.reconciled" } })).toBe(1);
  });

  it("serializes opposite manual decisions without changing an already settled payment", async () => {
    const f = await sentPayment();
    const responses = await Promise.all([resolve(f.payment.id, "declined"), resolve(f.payment.id, "approved")]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
    const payment = await db.payment.findUniqueOrThrow({ where: { id: f.payment.id } });
    const order = await db.order.findUniqueOrThrow({ where: { id: f.order.id } });
    expect(order.status).toBe(payment.status === "approved" ? "paid" : "open");
    expect(await db.simpleInvoice.count({ where: { orderId: f.order.id } })).toBe(payment.status === "approved" ? 1 : 0);
    expect(await db.auditEvent.count({ where: { targetId: f.payment.id, kind: "payment.reconciled" } })).toBe(1);
  });

  it("retains permissions, tenant isolation and explicit confirmation before acquiring money state", async () => {
    const f = await sentPayment();
    expect((await resolve(f.payment.id, "declined", { confirmed: false })).status).toBe(400);
    expect((await resolve(f.payment.id, "declined", { evidence: "short" })).status).toBe(400);
    scope.role = "mesero";
    expect((await resolve(f.payment.id, "declined")).status).toBe(403);
    scope.role = "operator";
    const other = await createTenant();
    scope.restaurantId = other.tenant.id;
    expect((await resolve(f.payment.id, "declined")).status).toBe(403);
    expect(await db.payment.findUniqueOrThrow({ where: { id: f.payment.id } })).toMatchObject({ status: "pending", providerRef: null });
    expect(await db.auditEvent.count({ where: { targetId: f.payment.id } })).toBe(0);
  });

  it("accepts a real late approval after manual cancellation once and marks it for reconciliation", async () => {
    const f = await sentPayment();
    expect((await resolve(f.payment.id, "declined")).status).toBe(200);
    const event = callback(f, true);
    expect(await processKushkiWebhook(event)).toEqual({ status: "ok" });
    expect(await processKushkiWebhook(event)).toEqual({ status: "duplicate" });
    expect(await processKushkiWebhook(callback(f, true))).toEqual({ status: "ok" });
    expect(await db.payment.findUniqueOrThrow({ where: { id: f.payment.id } })).toMatchObject({
      status: "approved", providerRef: event.providerRef, reconciliationRequired: true,
    });
    expect(await db.payment.count({ where: { orderId: f.order.id } })).toBe(1);
    expect(await db.simpleInvoice.count({ where: { orderId: f.order.id } })).toBe(1);
    expect(await db.auditEvent.findFirstOrThrow({ where: { targetId: f.payment.id, kind: "payment.reconciled" } })).toMatchObject({
      summary: evidence, diff: { outcome: "declined", manualTerminalResolution: true },
    });
  });

  it("rejects late callbacks with a different tenant, order or amount before changing a manual decision", async () => {
    const f = await sentPayment();
    expect((await resolve(f.payment.id, "declined")).status).toBe(200);
    const other = await createTenant();
    const rejectedEvents: string[] = [];
    for (const override of [{ restaurantId: other.tenant.id }, { orderId: randomUUID() }, { amountCents: f.payment.amountCents + 1 }]) {
      const event = callback(f, true, override);
      rejectedEvents.push(event.eventId);
      expect(await processKushkiWebhook(event)).toEqual({ status: "error", message: "webhook_processing_failed" });
    }
    expect(await db.payment.findUniqueOrThrow({ where: { id: f.payment.id } })).toMatchObject({
      status: "declined", reconciliationRequired: false, providerRef: manualTerminalRef(scope.userId, f.payment.id),
    });
    expect(await db.simpleInvoice.count({ where: { orderId: f.order.id } })).toBe(0);
    expect(await db.kushkiWebhookEvent.count({ where: { eventId: { in: rejectedEvents } } })).toBe(0);
  });

  it("links an approved manual receipt to the actual provider reference without another charge or invoice", async () => {
    const f = await sentPayment();
    expect((await resolve(f.payment.id, "approved")).status).toBe(200);
    const invoice = await db.simpleInvoice.findUniqueOrThrow({ where: { orderId: f.order.id } });
    const event = callback(f, true);
    expect(await processKushkiWebhook(event)).toEqual({ status: "ok" });
    expect(await processKushkiWebhook(callback(f, true))).toEqual({ status: "ok" });
    expect(await db.payment.findUniqueOrThrow({ where: { id: f.payment.id } })).toMatchObject({
      status: "approved", providerRef: event.providerRef, reconciliationRequired: false,
    });
    const charges = await db.kushkiTransaction.findMany({ where: { paymentId: f.payment.id, kind: "charge", status: "approved" } });
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({ kushkiTxId: event.providerRef, approvalCode: "LOCAL-VOUCHER-123" });
    expect(await db.simpleInvoice.findUniqueOrThrow({ where: { orderId: f.order.id } })).toMatchObject({ id: invoice.id, invoiceNumber: invoice.invoiceNumber });
    expect(await db.auditEvent.count({ where: { targetId: f.payment.id, kind: "payment.reconciled" } })).toBe(1);
    expect(await processKushkiWebhook(callback(f, true, { providerRef: `different-${randomUUID()}` }))).toMatchObject({ status: "error" });
  });

  it("serializes a provider approval racing with manual cancellation and accounts for the payment once", async () => {
    const f = await sentPayment();
    const event = callback(f, true);
    const [manual, provider] = await Promise.all([
      resolve(f.payment.id, "declined"), processKushkiWebhook(event),
    ]);
    expect([200, 409]).toContain(manual.status);
    expect(provider).toEqual({ status: "ok" });
    expect(await db.payment.findUniqueOrThrow({ where: { id: f.payment.id } })).toMatchObject({
      status: "approved", providerRef: event.providerRef, reconciliationRequired: manual.status === 200,
    });
    expect(await db.payment.count({ where: { orderId: f.order.id, status: "approved" } })).toBe(1);
    expect(await db.simpleInvoice.count({ where: { orderId: f.order.id } })).toBe(1);
    expect(await db.kushkiTransaction.count({ where: { paymentId: f.payment.id, kind: "charge", status: "approved" } })).toBe(1);
  });

  it.each([true, false])("retains an approved manual receipt and flags a contradictory decline (provider reference: %s)", async hasReference => {
    const f = await sentPayment();
    expect((await resolve(f.payment.id, "approved")).status).toBe(200);
    const invoice = await db.simpleInvoice.findUniqueOrThrow({ where: { orderId: f.order.id } });
    const event = callback(f, false, hasReference ? {} : { providerRef: undefined });
    expect(await processKushkiWebhook(event)).toMatchObject({ status: "ok", requiresReview: true });
    expect(await processKushkiWebhook(event)).toMatchObject({ status: "duplicate", requiresReview: true });
    expect(await db.payment.findUniqueOrThrow({ where: { id: f.payment.id } })).toMatchObject({ status: "approved", reconciliationRequired: true });
    expect(await db.order.findUniqueOrThrow({ where: { id: f.order.id } })).toMatchObject({ status: "paid" });
    expect(await db.simpleInvoice.findUniqueOrThrow({ where: { orderId: f.order.id } })).toMatchObject({ id: invoice.id });
    expect(await db.kushkiTransaction.count({ where: { paymentId: f.payment.id, kind: "charge", status: "approved" } })).toBe(1);
  });

  it("flags a late approval after a replacement cash payment without issuing another invoice", async () => {
    const f = await sentPayment();
    expect((await resolve(f.payment.id, "declined")).status).toBe(200);
    // Simulate the already verified replacement tender locally; never initiate a real charge.
    await db.$transaction(async tx => {
      const cash = await tx.payment.create({ data: { orderId: f.order.id, method: "cash", status: "approved", amountCents: f.payment.amountCents } });
      payments.push(cash.id);
      await recomputeOrderTotalsInTx(tx, f.order.id);
    });
    await issueInvoiceOnPaid({ tenantId: scope.restaurantId, orderId: f.order.id, emit: "none" });
    const invoice = await db.simpleInvoice.findUniqueOrThrow({ where: { orderId: f.order.id } });
    expect(await processKushkiWebhook(callback(f, true))).toEqual({ status: "ok" });
    expect(await db.payment.findUniqueOrThrow({ where: { id: f.payment.id } })).toMatchObject({ status: "approved", reconciliationRequired: true });
    expect(await db.payment.count({ where: { orderId: f.order.id, status: "approved" } })).toBe(2);
    expect(await db.order.findUniqueOrThrow({ where: { id: f.order.id } })).toMatchObject({ status: "paid", totalCents: 100_000 });
    expect(await db.simpleInvoice.count({ where: { orderId: f.order.id } })).toBe(1);
    expect(await db.simpleInvoice.findUniqueOrThrow({ where: { orderId: f.order.id } })).toMatchObject({ id: invoice.id, totalCents: 100_000 });
  });
});
