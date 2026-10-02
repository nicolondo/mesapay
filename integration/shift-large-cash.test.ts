import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { POST as close } from "../src/app/api/operator/shifts/close/route";
import { POST as open } from "../src/app/api/operator/shifts/open/route";
import { GET as current } from "../src/app/api/operator/shifts/current/route";
import { POST as closeWaiter } from "../src/app/api/mesero/shift/close/route";
import { getRecentShifts } from "../src/lib/shift";
import { buildShiftReport, listShiftsWithSummary } from "../src/lib/shiftReport";
import { buildCashSnapshot } from "../src/lib/cashBox";

const scope = vi.hoisted(() => ({ restaurantId: "", userId: "", role: "operator" }));
vi.mock("../src/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("../src/auth", () => ({ auth: async () => ({ user: { id: scope.userId, role: scope.role } }) }));
vi.mock("../src/lib/activeRestaurant", () => ({ getActiveRestaurantId: async () => scope.restaurantId }));
vi.mock("../src/lib/events", () => ({ publishOrderEvent: vi.fn() }));
const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["localhost", "127.0.0.1"].includes(database.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname)) throw new Error("Isolated local database required");
const tenants: string[] = [];
let tableId: string;
const request = (data: unknown) => new Request("http://localhost/api/operator/shifts/close", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
async function start(base = 40_000_000) {
  const response = await open(request({ openingCashCents: base }));
  expect(response.status).toBe(200);
  const { shiftId } = await response.json();
  // Ensure payments are strictly inside the shift interval.
  await db.shift.update({ where: { id: shiftId }, data: { openedAt: new Date(Date.now() - 60000) } });
  return shiftId as string;
}
async function payments(total: number, collector: string | null = null) {
  for (let remaining = total; remaining > 0;) {
    const amountCents = Math.min(remaining, 1_000_000_000);
    // A shift accumulates several paid bills. Each fixture must have an
    // outstanding balance before payment, just like the production trigger
    // requires; the aggregate shift total can exceed an individual bill's Int.
    const order = await db.order.create({ data: {
      restaurantId: scope.restaurantId, tableId, status: "placed", shortCode: randomUUID(),
      subtotalCents: amountCents, totalCents: amountCents,
    } });
    await db.payment.create({ data: { orderId: order.id, method: "cash", status: "approved", amountCents, settledAt: new Date(), collectedByUserId: collector } });
    await db.order.update({ where: { id: order.id }, data: { status: "paid" } });
    remaining -= amountCents;
  }
}
beforeEach(async () => {
  const tenant = await db.restaurant.create({ data: { name: "Prueba cierre alto", slug: `shift-${randomUUID()}` } });
  scope.restaurantId = tenant.id; tenants.push(tenant.id); scope.role = "operator";
  const user = await db.user.create({ data: { restaurantId: tenant.id, role: "operator", email: `${randomUUID()}@example.test`, passwordHash: "test-only" } });
  scope.userId = user.id;
  tableId = (await db.table.create({ data: { restaurantId: tenant.id, number: 1, qrToken: randomUUID() } })).id;
});
afterAll(async () => { await db.restaurant.deleteMany({ where: { id: { in: tenants } } }); await db.$disconnect(); });

describe("large cash shift totals on PostgreSQL", () => {
  it.each([2_771_025_000, 3_433_623_000])("closes %i cents exactly and reads it through history/report/JSON", async (total) => {
    const shiftId = await start(); await payments(total - 40_000_000);
    const response = await close(request({ declaredCashCents: total }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ expectedCashCents: total, cashDiffCents: 0 });
    const persisted = await db.shift.findUniqueOrThrow({ where: { id: shiftId } });
    expect(Number(persisted.declaredCashCents)).toBe(total);
    expect(Number(persisted.expectedCashCents)).toBe(total);
    expect(persisted.status).toBe("closed");
    expect(await db.payment.count({ where: { shiftId } })).toBe(3 + (total > 3_000_000_000 ? 1 : 0));
    const history = await getRecentShifts(scope.restaurantId);
    expect(history[0].declaredCashCents).toBe(total);
    expect(() => JSON.stringify(history)).not.toThrow();
    const report = await buildShiftReport(shiftId);
    expect(() => JSON.stringify(report)).not.toThrow();
    expect(JSON.stringify(report)).toContain(String(total));
    const summary = await listShiftsWithSummary(scope.restaurantId);
    expect(() => JSON.stringify(summary)).not.toThrow();
    expect(await close(request({ declaredCashCents: total })).then(r => r.status)).toBe(409);
  });

  it("supports the existing100M COP limit as a base and negative difference", async () => {
    const shiftId = await start(10_000_000_000);
    const response = await current(new Request("http://localhost/api/operator/shifts/current"));
    expect(await response.json()).toMatchObject({ shift: { openingCashCents: 10_000_000_000 }, expectedCashCents: 10_000_000_000 });
    const closed = await close(request({ declaredCashCents: 0 }));
    expect(closed.status).toBe(200);
    expect(await closed.json()).toMatchObject({ cashDiffCents: -10_000_000_000 });
    expect(Number((await db.shift.findUniqueOrThrow({ where: { id: shiftId } })).cashDiffCents)).toBe(-10_000_000_000);
  });

  it("keeps the input cap and does not close when it is exceeded", async () => {
    const shiftId = await start();
    expect((await close(request({ declaredCashCents: 10_000_000_001 }))).status).toBe(400);
    expect((await db.shift.findUniqueOrThrow({ where: { id: shiftId } })).status).toBe("open");
  });

  it("closes a waiter shift aboveINT4 and returns a numeric JSON summary", async () => {
    const local = await start();
    const waiter = await db.user.create({ data: { restaurantId: scope.restaurantId, role: "mesero", email: `${randomUUID()}@example.test`, passwordHash: "test-only" } });
    const shift = await db.shift.create({ data: { restaurantId: scope.restaurantId, userId: waiter.id, openedById: waiter.id, openingCashCents: 40_000_000, openedAt: new Date(Date.now() - 30000) } });
    await payments(2_731_025_000, waiter.id);
    scope.userId = waiter.id; scope.role = "mesero";
    const response = await closeWaiter(request({ declaredCashCents: 2_771_025_000 }));
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).toContain("2771025000");
    expect(Number((await db.shift.findUniqueOrThrow({ where: { id: shift.id } })).expectedCashCents)).toBe(2_771_025_000);
    expect((await db.shift.findUniqueOrThrow({ where: { id: local } })).status).toBe("open");
  });

  it("general closing also stores high waiter returns and clears the cash snapshot", async () => {
    await db.restaurant.update({ where: { id: scope.restaurantId }, data: { shiftPolicy: "by_waiter" } });
    await start();
    const waiter = await db.user.create({ data: { restaurantId: scope.restaurantId, role: "mesero", email: `${randomUUID()}@example.test`, passwordHash: "test-only" } });
    const shift = await db.shift.create({ data: { restaurantId: scope.restaurantId, userId: waiter.id, openedById: waiter.id, openingCashCents: 10_000_000, openedAt: new Date(Date.now() - 30000) } });
    await payments(2_731_025_000, waiter.id);
    const snapshot = await buildCashSnapshot(scope.restaurantId, "by_waiter");
    expect(snapshot.consolidatedCents).toBe(2_771_025_000);
    expect(snapshot.meseros[0].mustReturnCents).toBe(2_741_025_000);
    const response = await close(request({ declaredCashCents: snapshot.consolidatedCents, closeMeseroShifts: true }));
    expect(response.status).toBe(200);
    expect(Number((await db.shift.findUniqueOrThrow({ where: { id: shift.id } })).declaredCashCents)).toBe(2_741_025_000);
    expect((await buildCashSnapshot(scope.restaurantId, "by_waiter")).open).toBe(false);
  });
});
