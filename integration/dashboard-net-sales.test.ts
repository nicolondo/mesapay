import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { db } from "../src/lib/db";
import { loadDashboardSales } from "../src/lib/reports/dashboardSalesQuery";
import { summarizeDashboardSales } from "../src/lib/reports/dashboardSales";

const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["localhost", "127.0.0.1"].includes(database.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname)) {
  throw new Error("Isolated local database required");
}
const RANGE = { from: new Date("2026-10-14T10:00:00Z"), to: new Date("2026-10-21T10:00:00Z") };
const INC8 = { kind: "inc" as const, pct: 8 };
const tenantIds: string[] = [];
let restaurantId: string;
let tableId: string;

async function tenant() {
  const restaurant = await db.restaurant.create({ data: {
    name: "Dashboard net sales fixture", slug: `dashboard-net-${randomUUID()}`,
    businessDayCutoffHour: 5, salesTaxKind: "inc", salesTaxPct: 8,
  } });
  tenantIds.push(restaurant.id);
  const table = await db.table.create({ data: { restaurantId: restaurant.id, number: 1, qrToken: randomUUID() } });
  return { restaurantId: restaurant.id, tableId: table.id };
}

function order(patch: Partial<Prisma.OrderUncheckedCreateInput> = {}) {
  return db.order.create({ data: {
    restaurantId, tableId, shortCode: randomUUID(), status: "paid",
    createdAt: new Date("2026-10-13T19:00:00Z"), paidAt: new Date("2026-10-20T19:00:00Z"),
    subtotalCents: 3_000_000, tipCents: 300_000, taxCents: 0, totalCents: 3_300_000,
    ...patch,
  } });
}

function invoice(orderId: string, snapshot: Prisma.InputJsonValue, invoiceTenantId = restaurantId) {
  return db.simpleInvoice.create({ data: {
    restaurantId: invoiceTenantId, orderId, invoiceNumber: 1, totalCents: 3_300_000, snapshot,
  } });
}

function item(orderId: string, patch: Partial<Prisma.OrderItemUncheckedCreateInput> = {}) {
  return db.orderItem.create({ data: {
    orderId, nameSnapshot: "Menu fixture", priceCentsSnapshot: 3_000_000, qty: 1,
    taxKind: null, cancelledAt: null, ...patch,
  } });
}

beforeEach(async () => { ({ restaurantId, tableId } = await tenant()); });
afterAll(async () => {
  try { await db.restaurant.deleteMany({ where: { id: { in: tenantIds } } }); }
  finally { await db.$disconnect(); }
});

describe("dashboard net sales on PostgreSQL", () => {
  it("removes frozen embedded tax, on-top tax and tips without reapplying the discount", async () => {
    const account = await order({
      subtotalCents: 103_000_000, taxCents: 19_000_000, discountCents: 300_000,
      tipCents: 270_000, totalCents: 121_970_000,
    });
    await invoice(account.id, {
      salesTaxKind: "inc", embeddedTaxCents: 222_222,
      taxCents: 19_000_000, discountCents: 300_000,
      customer: { name: "Not projected", email: "never-return@example.test" },
      items: [{ name: "Not projected", qty: 1 }],
    });
    const rows = await loadDashboardSales(restaurantId, RANGE, { kind: "none", pct: 0 });
    expect(rows).toEqual([{ paidAt: account.paidAt, netCents: 102_477_778 }]);
    expect(await db.order.findUniqueOrThrow({ where: { id: account.id } })).toMatchObject({
      totalCents: 121_970_000, discountCents: 300_000, taxCents: 19_000_000, tipCents: 270_000,
    });
  });

  it("uses paidAt and the exact cutoff window, excluding another merchant and unpaid orders", async () => {
    const dates = [
      "2026-10-14T10:00:00Z", "2026-10-18T06:18:00Z", "2026-10-20T10:00:00Z",
      "2026-10-21T09:59:59.999Z", "2026-10-14T09:59:59.999Z", "2026-10-21T10:00:00Z",
    ];
    for (const paidAt of dates) {
      const account = await order({ paidAt: new Date(paidAt) });
      await invoice(account.id, { salesTaxKind: "inc", embeddedTaxCents: 222_222 });
    }
    await order({ status: "open" });
    await order({ status: "cancelled" });
    await order({ paidAt: null });
    const other = await tenant();
    await order(other);
    const rows = await loadDashboardSales(restaurantId, RANGE, INC8);
    const summary = summarizeDashboardSales(rows, { from: RANGE.from, days: 7 });
    expect(rows).toHaveLength(4);
    expect(summary.days.map((day) => day.paidCount)).toEqual([1, 0, 0, 1, 0, 0, 2]);
    expect(summary.todayNetCents).toBe(5_555_556);
    expect(summary.totalNetCents).toBe(11_111_112);
    expect(summary.avgTicketNetCents).toBe(2_777_778);
  });

  it("only uses live menu lines for uninvoiced orders and preserves per-line fiscal rounding", async () => {
    const account = await order({ totalCents: 7_320, subtotalCents: 7_030, tipCents: 100, taxCents: 190 });
    await item(account.id, { priceCentsSnapshot: 3_015 });
    await item(account.id, { priceCentsSnapshot: 3_015 });
    await item(account.id, { priceCentsSnapshot: 1_000, taxKind: "iva", taxPct: 19 });
    await item(account.id, { cancelledAt: new Date(), priceCentsSnapshot: 100_000 });
    await item(account.id, { cancelledAt: new Date(), cancellationKind: "comp", priceCentsSnapshot: 100_000 });
    const cancelled = await db.round.create({ data: { orderId: account.id, seq: 1, status: "cancelled" } });
    await item(account.id, { roundId: cancelled.id, priceCentsSnapshot: 100_000 });
    expect(await loadDashboardSales(restaurantId, RANGE, INC8))
      .toEqual([{ paidAt: account.paidAt, netCents: 6_584 }]);
  });

  it("does not retroactively invent tax for legacy invoices or crash on malformed JSON tax", async () => {
    for (const snapshot of [
      {}, { salesTaxKind: "none", embeddedTaxCents: 222_222 },
      { salesTaxKind: "inc", embeddedTaxCents: "not-a-number" },
      { salesTaxKind: "inc", embeddedTaxCents: { unexpected: true } },
      { salesTaxKind: "inc", embeddedTaxCents: -1 },
    ]) {
      const account = await order();
      await invoice(account.id, snapshot);
      await item(account.id);
    }
    const rows = await loadDashboardSales(restaurantId, RANGE, INC8);
    expect(rows).toHaveLength(5);
    expect(rows.every((sale) => sale.netCents === 3_000_000)).toBe(true);
  });

  it("does not consume a mismatched tenant's invoice snapshot", async () => {
    const account = await order();
    await item(account.id);
    const other = await tenant();
    await invoice(account.id, { salesTaxKind: "iva", embeddedTaxCents: 999_999 }, other.restaurantId);
    expect(await loadDashboardSales(restaurantId, RANGE, INC8))
      .toEqual([{ paidAt: account.paidAt, netCents: 2_777_778 }]);
  });

  it("preserves the paid-order count for zero-value courtesy accounts without adding sales", async () => {
    const comp = await order({ subtotalCents: 0, totalCents: 0, tipCents: 0, compedAt: new Date(), compAmountCents: 3_000_000 });
    await item(comp.id, { cancelledAt: new Date(), cancellationKind: "comp" });
    const rows = await loadDashboardSales(restaurantId, RANGE, INC8);
    const summary = summarizeDashboardSales(rows, { from: RANGE.from, days: 7 });
    expect(summary).toMatchObject({ totalNetCents: 0, todayNetCents: 0, todayPaidCount: 1, avgTicketNetCents: 0 });
  });
});
