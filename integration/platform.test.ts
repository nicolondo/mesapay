import { reconcilePayment } from "../src/lib/payments/reconciliation";
import { markRecurringChargeFailed } from "../src/lib/billing/subscription";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { reservePayment } from "../src/lib/payments/intent";
import { processKushkiWebhook } from "../src/lib/payments/webhookHandler";
import { applyStockMovement } from "../src/lib/erp/stock";
import { applyDinerToOrder } from "../src/lib/dinerDiscount";
import { lockOrder } from "../src/lib/orderLock";

// Keep external side effects out of a real PostgreSQL transaction test.
vi.mock("@/lib/events", () => ({ publishOrderEvent: vi.fn() }));
vi.mock("@/lib/invoiceOnPaid", () => ({ issueRequestedInvoiceOnPaid: vi.fn() }));

const url = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["127.0.0.1", "localhost"].includes(url.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(url.pathname)) {
  throw new Error("Integration tests require an explicitly selected local mesapay_*test or mesapay_*validation database");
}
const fixture = `integration-${randomUUID()}`;
let tenantId: string;
let tableId: string;
const orders: string[] = [];
const events: string[] = [];
async function order(amount = 10000, discount = 0, tax = 0) {
  const o = await db.order.create({ data: { restaurantId: tenantId, tableId, shortCode: randomUUID(), subtotalCents: amount, discountCents: discount, taxCents: tax, totalCents: amount + tax - discount, status: "placed" } });
  orders.push(o.id);
  return o;
}
beforeAll(async () => {
  tenantId = (await db.restaurant.create({ data: { slug: fixture, name: fixture } })).id;
  tableId = (await db.table.create({ data: { restaurantId: tenantId, number: 1, qrToken: randomUUID() } })).id;
});
afterAll(async () => {
  await db.kushkiWebhookEvent.deleteMany({ where: { eventId: { in: events } } });
  await db.financialOperation.deleteMany({ where: { paymentId: { in: (await db.payment.findMany({ where: { orderId: { in: orders } }, select: { id: true } })).map(p => p.id) } } });
  await db.kushkiWebhookEvent.deleteMany({ where: { restaurantId: tenantId } });
  await db.restaurant.delete({ where: { id: tenantId } });
  await db.platformEvent.deleteMany({ where: { restaurantId: tenantId } });
  await db.$disconnect();
});

describe("financial invariants on PostgreSQL", () => {
  it("only one of two concurrent full payments can reserve the balance", async () => {
    const o = await order();
    const input = { orderId: o.id, method: "kushki_card" as const, amountCents: 10000, status: "pending" as const };
    const results = await Promise.allSettled([reservePayment(input, "first"), reservePayment(input, "second")]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.payment.count({ where: { orderId: o.id } })).toBe(1);
  });
  it("replaying one token returns one intent; changing its amount conflicts", async () => {
    const o = await order();
    const input = { orderId: o.id, method: "kushki_card" as const, amountCents: 5000, status: "pending" as const };
    const [a, b] = await Promise.all([reservePayment(input, "same"), reservePayment(input, "same")]);
    expect(a.payment.id).toBe(b.payment.id);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    await expect(reservePayment({ ...input, amountCents: 4000 }, "same")).rejects.toThrow("operation_conflict");
  });
  it("discount and added tax bound the payment and remain in the persisted total", async () => {
    const o = await order(10000, 1000, 1900);
    await expect(reservePayment({ orderId: o.id, method: "kushki_card", amountCents: 11900 }, "too-much")).rejects.toThrow();
    const { payment } = await reservePayment({ orderId: o.id, method: "kushki_card", amountCents: 11900, tipCents: 1000 }, "correct");
    const eventId = `${fixture}:approved`; events.push(eventId);
    const payload = { eventId, type: "charge.approved" as const, paymentId: payment.id, restaurantId: tenantId, amountCents: 11900, providerRef: `${fixture}-charge` };
    const results = await Promise.all([processKushkiWebhook(payload), processKushkiWebhook(payload)]);
    expect(results.map(r => r.status).sort()).toEqual(["duplicate", "ok"]);
    const settled = await db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(settled.status).toBe("paid");
    expect(settled.totalCents).toBe(11900);
    expect(settled.taxCents).toBe(1900);
    expect(await db.kushkiTransaction.count({ where: { paymentId: payment.id } })).toBe(1);
    expect(await db.platformEvent.count({ where: { orderId: o.id, payload: { path: ["type"], equals: "order.paid" } } })).toBeGreaterThan(0);
  });
  it("wrong amount rolls back the webhook claim and can be retried correctly", async () => {
    const o = await order();
    const { payment } = await reservePayment({ orderId: o.id, method: "kushki_card", amountCents: 10000 }, "charge");
    const eventId = `${fixture}:retry`; events.push(eventId);
    const payload = { eventId, type: "charge.approved" as const, paymentId: payment.id, restaurantId: tenantId };
    expect((await processKushkiWebhook({ ...payload, amountCents: 9999 })).status).toBe("error");
    expect(await db.kushkiWebhookEvent.findUnique({ where: { eventId } })).toBeNull();
    expect((await db.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe("pending");
    expect((await processKushkiWebhook({ ...payload, amountCents: 10000 })).status).toBe("ok");
  });
  it("does not approve a cancelled order or resurrect a refunded payment", async () => {
    const o = await order();
    const { payment } = await reservePayment({ orderId: o.id, method: "kushki_card", amountCents: 10000 }, "late");
    await db.order.update({ where: { id: o.id }, data: { status: "cancelled" } });
    const eventId = `${fixture}:late`; events.push(eventId);
    expect((await processKushkiWebhook({ eventId, type: "charge.approved", paymentId: payment.id })).status).toBe("ok");
    expect((await db.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("cancelled");
    expect((await db.payment.findUniqueOrThrow({ where: { id: payment.id } })).reconciliationRequired).toBe(true);
    await db.payment.update({ where: { id: payment.id }, data: { status: "refunded", refundedCents: 10000 } });
    const second = `${eventId}:again`; events.push(second);
    await processKushkiWebhook({ eventId: second, type: "charge.approved", paymentId: payment.id });
    expect((await db.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe("refunded");
  });
  it("serializes refund reservations and enforces the cumulative refund bound", async () => {
    const o = await order();
    const payment = await db.payment.create({ data: { orderId: o.id, method: "kushki_card", amountCents: 10000, status: "approved" } });
    const claim = () => db.$transaction(async tx => {
      await lockOrder(tx, o.id);
      const current = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
      if (current.refundReservedCents) throw new Error("already_reserved");
      await tx.payment.update({ where: { id: payment.id }, data: { refundReservedCents: 7000 } });
    });
    const results = await Promise.allSettled([claim(), claim()]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    await expect(db.payment.update({ where: { id: payment.id }, data: { refundedCents: 4000 } })).rejects.toThrow();
  });
  it("cannot change the discount after a payment has reserved the bill", async () => {
    const o = await order();
    const diner = await db.diner.create({ data: { restaurantId: tenantId, email: `${fixture}@example.test`, passwordHash: "test" } });
    await db.dinerDiscount.create({ data: { dinerId: diner.id, percent: 10 } });
    const applied = await applyDinerToOrder({ orderId: o.id, restaurantId: tenantId, dinerId: diner.id });
    expect(applied?.discountCents).toBe(1000);
    await reservePayment({ orderId: o.id, method: "kushki_card", amountCents: 9000 }, "discounted");
    expect(await applyDinerToOrder({ orderId: o.id, restaurantId: tenantId, dinerId: diner.id })).toBeNull();
  });
});

describe("verified reconciliation and subscription retries", () => {
  it("two simultaneous confirmations complete one uncertain refund and one audit record", async () => {
    const o = await order();
    const payment = await db.payment.create({ data: { orderId: o.id, method: "kushki_card", amountCents: 10000, status: "approved", reconciliationRequired: true, refundReservedCents: 5000 } });
    await db.financialOperation.create({ data: { key: `${fixture}:refund`, paymentId: payment.id, kind: "refund", amountCents: 5000, status: "uncertain" } });
    const args = { paymentId: payment.id, restaurantId: tenantId, outcome: "refunded" as const, evidence: "Verified with the isolated provider fixture", providerRef: "refund-confirmation", actor: { id: "test-actor", email: "test@example.test", role: "operator" } };
    const results = await Promise.all([reconcilePayment(args), reconcilePayment(args)]);
    expect(results.filter(r => r.alreadyResolved)).toHaveLength(1);
    const result = await db.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(result.refundedCents).toBe(5000); expect(result.refundReservedCents).toBe(0); expect(result.reconciliationRequired).toBe(false);
    expect(await db.kushkiTransaction.count({ where: { paymentId: payment.id, kind: "refund" } })).toBe(1);
    expect(await db.auditEvent.count({ where: { targetId: payment.id, kind: "payment.reconciled" } })).toBe(1);
  });
  it("reconciliation cannot cross restaurant boundaries", async () => {
    const o = await order();
    const payment = await db.payment.create({ data: { orderId: o.id, method: "kushki_card", amountCents: 10000, reconciliationRequired: true } });
    await expect(reconcilePayment({ paymentId: payment.id, restaurantId: "other", outcome: "approved", evidence: "Verified fixture evidence", providerRef: "test-provider", actor: { id: "test", email: "test@example.test", role: "operator" } })).rejects.toThrow("operation_conflict");
    expect((await db.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe("pending");
  });
  it("a repeated failed subscription event increments the retry counter once", async () => {
    await db.billingSubscription.create({ data: { restaurantId: tenantId, provider: "kushki", plan: "basic", amountCents: 10000, currency: "COP", status: "active" } });
    const results = await Promise.all([markRecurringChargeFailed(tenantId, fixture), markRecurringChargeFailed(tenantId, fixture)]);
    expect(results.sort()).toEqual([false, true]);
    expect((await db.billingSubscription.findUniqueOrThrow({ where: { restaurantId: tenantId } })).failedAttempts).toBe(1);
  });
});

describe("inventory and revocation on PostgreSQL", () => {
  it("concurrent stock deductions preserve quantity and valuation", async () => {
    const ingredient = await db.ingredient.create({ data: { restaurantId: tenantId, name: "test", measureKind: "count" } });
    await db.stockLevel.create({ data: { restaurantId: tenantId, ingredientId: ingredient.id, qtyBase: 100, totalValueCents: 10000 } });
    await Promise.all([10, 20].map(qtyBase => db.$transaction(tx => applyStockMovement(tx, { restaurantId: tenantId, ingredientId: ingredient.id, kind: "sale_consumption", qtyBase }))));
    const level = await db.stockLevel.findUniqueOrThrow({ where: { ingredientId: ingredient.id } });
    expect(level.qtyBase).toBe(70);
    expect(level.totalValueCents).toBe(7000);
  });
  it("password, role and disable changes revoke existing session versions", async () => {
    const user = await db.user.create({ data: { restaurantId: tenantId, email: `${fixture}@example.test`, passwordHash: "test", role: "operator" } });
    const renamed = await db.user.update({ where: { id: user.id }, data: { name: "renamed" } });
    expect(renamed.sessionVersion).toBe(user.sessionVersion);
    for (const data of [{ passwordHash: "changed" }, { role: "mesero" as const }, { disabledAt: new Date() }]) {
      await db.user.update({ where: { id: user.id }, data });
    }
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).sessionVersion).toBe(user.sessionVersion + 3);
  });
});
