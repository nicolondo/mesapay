import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { db } from "../src/lib/db";
import { computeClosedShiftMetrics, computeOpenShiftMetrics, getRecentShifts } from "../src/lib/shift";
import { buildShiftReport, listShiftsWithSummary } from "../src/lib/shiftReport";
import { loadShiftConsumptionTax } from "../src/lib/reports/shiftConsumptionTaxQuery";
import { POST as closeGlobal } from "../src/app/api/operator/shifts/close/route";

const scope = vi.hoisted(() => ({ restaurantId: "", userId: "" }));
vi.mock("../src/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("../src/auth", () => ({ auth: async () => ({ user: { id: scope.userId, role: "operator", restaurantId: scope.restaurantId } }) }));
vi.mock("../src/lib/activeRestaurant", () => ({ getActiveRestaurantId: async () => scope.restaurantId }));
vi.mock("../src/lib/events", () => ({ publishOrderEvent: vi.fn() }));

const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["localhost", "127.0.0.1"].includes(database.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname)) {
  throw new Error("Isolated local database required");
}
const tenants: string[] = [];
const FROM = new Date("2026-10-27T17:00:00Z");
const SPLIT = new Date("2026-10-28T00:00:00Z");
const TO = new Date("2026-10-28T06:00:00Z");
const t = (consumptionTaxCents: number, taxPendingPayments = 0) => ({ consumptionTaxCents, taxPendingPayments });
let tableId: string;
let waiterId: string;

async function tenant() {
  const restaurant = await db.restaurant.create({ data: {
    name: "Shift consumption tax fixture", slug: `shift-inc-${randomUUID()}`, salesTaxKind: "inc", salesTaxPct: 8,
  } });
  tenants.push(restaurant.id);
  const user = await db.user.create({ data: { restaurantId: restaurant.id, role: "operator", email: `${randomUUID()}@example.test`, passwordHash: "test-only" } });
  const table = await db.table.create({ data: { restaurantId: restaurant.id, number: 1, qrToken: randomUUID() } });
  return { restaurantId: restaurant.id, userId: user.id, tableId: table.id };
}
async function shift(patch: Partial<Prisma.ShiftUncheckedCreateInput> = {}) {
  return db.shift.create({ data: {
    restaurantId: scope.restaurantId, openedById: scope.userId, openingCashCents: 1000,
    status: "closed", openedAt: FROM, closedAt: TO, ...patch,
  } });
}
async function sale(snapshot: Prisma.InputJsonValue | null = null, patch: Partial<Prisma.OrderUncheckedCreateInput> = {}) {
  const account = await db.order.create({ data: {
    restaurantId: scope.restaurantId, tableId, shortCode: randomUUID(), status: "paid",
    subtotalCents: 10800, totalCents: 11800, tipCents: 1000, paidAt: SPLIT, ...patch,
  } });
  if (snapshot !== null) await db.simpleInvoice.create({ data: {
    restaurantId: account.restaurantId, orderId: account.id, invoiceNumber: 1, totalCents: account.totalCents, snapshot,
  } });
  return account;
}
const frozen = (patch: Record<string, Prisma.InputJsonValue> = {}) => ({
  totalCents: 11800, tipCents: 1000, taxCents: 0, taxByKind: { inc: 0, iva: 0 },
  salesTaxKind: "inc", embeddedTaxCents: 800, ...patch,
});
async function pay(orderId: string, patch: Partial<Prisma.PaymentUncheckedCreateInput> = {}) {
  return db.payment.create({ data: {
    orderId, method: "cash", status: "approved", amountCents: 11800, tipCents: 1000,
    createdAt: SPLIT, settledAt: SPLIT, collectedByUserId: waiterId, ...patch,
  } });
}

beforeEach(async () => {
  const context = await tenant();
  scope.restaurantId = context.restaurantId;
  scope.userId = context.userId;
  tableId = context.tableId;
  waiterId = (await db.user.create({ data: { restaurantId: scope.restaurantId, role: "mesero", email: `${randomUUID()}@example.test`, passwordHash: "test-only" } })).id;
});
afterAll(async () => {
  try { await db.restaurant.deleteMany({ where: { id: { in: tenants } } }); }
  finally { await db.$disconnect(); }
});

describe("shift consumption tax on PostgreSQL", () => {
  it("shows frozen mixed INC separately while preserving existing gross, tips, food and cash", async () => {
    const closed = await shift();
    const a = await sale(frozen());
    const b = await sale(frozen({ totalCents: 6850, tipCents: 500, taxCents: 1350, taxByKind: { inc: 400, iva: 950 }, salesTaxKind: "none", embeddedTaxCents: 0 }), { totalCents: 6850, tipCents: 500, taxCents: 1350 });
    await pay(a.id, { shiftId: closed.id });
    await pay(b.id, { shiftId: closed.id, method: "kushki_card_terminal", amountCents: 6850, tipCents: 500 });
    expect(await computeClosedShiftMetrics(closed.id)).toMatchObject({ ...t(1200), grossCents: 18650, tipCents: 1500, cashCents: 11800, payments: 2 });
    expect((await buildShiftReport(closed.id))?.totals).toEqual({ ...t(1200), grossCents: 18650, tipCents: 1500, foodCents: 17150, paymentCount: 2, ordersClosed: 2 });
    expect((await listShiftsWithSummary(scope.restaurantId)).items[0]).toMatchObject({ id: closed.id, ...t(1200), grossCents: 18650 });
    expect((await getRecentShifts(scope.restaurantId))[0]).toMatchObject({ id: closed.id, ...t(1200), user: null });
    await db.restaurant.update({ where: { id: scope.restaurantId }, data: { salesTaxKind: "iva", salesTaxPct: 19 } });
    await db.order.update({ where: { id: a.id }, data: { totalCents: 99999, tipCents: 777 } });
    expect((await buildShiftReport(closed.id))?.totals).toMatchObject(t(1200));
  });

  it("allocates once across two shifts and keeps refunded shares out of later payments", async () => {
    const first = await shift({ closedAt: new Date(SPLIT.getTime() - 1) });
    const second = await shift({ openedAt: SPLIT });
    const account = await sale(frozen());
    const previous = await pay(account.id, { amountCents: 5900, tipCents: 500, shiftId: first.id, settledAt: FROM });
    await pay(account.id, { amountCents: 5900, tipCents: 500, shiftId: second.id });
    expect((await buildShiftReport(first.id))?.totals).toMatchObject(t(400));
    expect((await buildShiftReport(second.id))?.totals).toMatchObject(t(400));
    await db.payment.update({ where: { id: previous.id }, data: { status: "refunded", refundedCents: 5900, refundedAt: TO } });
    expect((await buildShiftReport(first.id))?.totals).toMatchObject({ ...t(0), paymentCount: 0 });
    expect((await buildShiftReport(second.id))?.totals).toMatchObject({ ...t(400), paymentCount: 1 });
  });

  it("marks absent/malformed invoices as pending, retains legacy zero and excludes pending payments", async () => {
    const closed = await shift();
    for (const snapshot of [null, {}, [], frozen({ embeddedTaxCents: "800" }), frozen({ totalCents: 999 }), { totalCents: 11800, tipCents: 1000 }]) {
      const account = await sale(snapshot);
      await pay(account.id, { shiftId: closed.id });
    }
    const account = await sale(frozen());
    await pay(account.id, { shiftId: closed.id, status: "pending" });
    await pay(account.id, { shiftId: closed.id, status: "declined" });
    expect((await buildShiftReport(closed.id))?.totals).toMatchObject({ ...t(0, 5), paymentCount: 6 });
    expect((await getRecentShifts(scope.restaurantId))[0]).toMatchObject(t(0, 5));
  });

  it("does not consume another restaurant's invoice or payments even with poisoned shift/waiter links", async () => {
    const closed = await shift();
    const personal = await shift({ userId: waiterId });
    const own = await sale();
    const ownPayment = await pay(own.id, { shiftId: closed.id });
    const other = await tenant();
    await db.simpleInvoice.create({ data: { restaurantId: other.restaurantId, orderId: own.id, invoiceNumber: 1, totalCents: 11800, snapshot: frozen() } });
    const foreign = await sale(frozen(), { restaurantId: other.restaurantId, tableId: other.tableId });
    const foreignPayment = await pay(foreign.id, { shiftId: closed.id });
    for (const id of [closed.id, personal.id]) {
      expect((await buildShiftReport(id))?.totals).toMatchObject({ ...t(0, 1), paymentCount: 1, grossCents: 11800 });
    }
    expect(await computeClosedShiftMetrics(closed.id)).toMatchObject({ ...t(0, 1), payments: 1 });
    expect((await listShiftsWithSummary(scope.restaurantId)).items.every((row) => row.paymentCount === 1 && row.taxPendingPayments === 1)).toBe(true);
    const selected = await loadShiftConsumptionTax(scope.restaurantId, [ownPayment, foreignPayment]);
    expect([...selected.values()]).toEqual([t(0, 1), t(0, 1)]);
  });

  it("loads many personal windows in batches and preserves their settlement boundaries", async () => {
    const first = await shift({ userId: waiterId, closedAt: new Date(SPLIT.getTime() - 1) });
    const second = await shift({ userId: waiterId, openedAt: SPLIT });
    const third = await shift({ userId: waiterId, openedAt: new Date(TO.getTime() + 1), closedAt: new Date(TO.getTime() + 2) });
    const account = await sale(frozen());
    await pay(account.id, { amountCents: 6400, tipCents: 1000, settledAt: new Date(SPLIT.getTime() - 1) });
    await pay(account.id, { amountCents: 5400, tipCents: 0, settledAt: SPLIT });
    const summary = await listShiftsWithSummary(scope.restaurantId);
    expect(summary.items.find((row) => row.id === first.id)).toMatchObject({ ...t(400), grossCents: 6400, paymentCount: 1 });
    expect(summary.items.find((row) => row.id === second.id)).toMatchObject({ ...t(400), grossCents: 5400, paymentCount: 1 });
    expect(summary.items.find((row) => row.id === third.id)).toMatchObject({ ...t(0), grossCents: 0, paymentCount: 0 });
  });

  it("exposes the same INC in an open shift, close response and pinned historical report", async () => {
    const opened = await shift({ status: "open", closedAt: null });
    const account = await sale(frozen());
    await pay(account.id);
    expect(await computeOpenShiftMetrics(scope.restaurantId, opened)).toMatchObject(t(800));
    const response = await closeGlobal(new Request("http://localhost/api/operator/shifts/close", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ declaredCashCents: 12800 }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, shiftId: opened.id, breakdown: t(800) });
    expect((await buildShiftReport(opened.id))?.totals).toMatchObject(t(800));
  });

  it("keeps zero-value courtesy accounts at zero without pending fiscal amounts", async () => {
    const closed = await shift();
    const account = await sale({ totalCents: 0, tipCents: 0 }, { totalCents: 0, tipCents: 0, subtotalCents: 0 });
    await pay(account.id, { amountCents: 0, tipCents: 0, shiftId: closed.id });
    expect((await buildShiftReport(closed.id))?.totals).toMatchObject({ ...t(0), paymentCount: 1 });
  });
});
