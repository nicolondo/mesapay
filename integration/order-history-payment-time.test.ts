import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { historyDate, historyQueries, mergeHistory } from "../src/lib/orders/history";

const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["localhost", "127.0.0.1"].includes(database.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname)) throw new Error("Isolated local database required");
const tenantIds: string[] = [];
let restaurantId: string;
let tableId: string;
let carriedSale: string;
const since = new Date("2026-09-29T10:00:00Z"); // 05:00 Bogotá business-day cutoff.
async function makeTenant() {
  const restaurant = await db.restaurant.create({ data: { name: "History test only", slug: `history-${randomUUID()}` } });
  tenantIds.push(restaurant.id);
  const table = await db.table.create({ data: { restaurantId: restaurant.id, number: 1, qrToken: randomUUID() } });
  return { restaurantId: restaurant.id, tableId: table.id };
}
async function history(status?: "paid", start: Date | null = since) {
  const streams = await Promise.all(historyQueries({ restaurantId, ...(status ? { status } : {}) }, start).map(q => db.order.findMany(q)));
  return mergeHistory(streams.flat());
}
beforeAll(async () => {
  ({ restaurantId, tableId } = await makeTenant());
  const fixtures = [
    { shortCode: "paid-today-opened-yesterday", createdAt: new Date("2026-09-28T15:00:00Z"), paidAt: new Date("2026-09-29T18:00:00Z"), status: "paid" as const },
    { shortCode: "new-unpaid", createdAt: new Date("2026-09-29T17:00:00Z"), paidAt: null, status: "open" as const },
    { shortCode: "previous-business-day", createdAt: new Date("2026-09-28T15:00:00Z"), paidAt: new Date("2026-09-29T09:59:59Z"), status: "paid" as const },
    { shortCode: "legacy-paid-no-date", createdAt: new Date("2026-09-29T12:00:00Z"), paidAt: null, status: "paid" as const },
    { shortCode: "cutoff-exact", createdAt: new Date("2026-09-28T15:00:00Z"), paidAt: since, status: "paid" as const },
  ];
  for (const fixture of fixtures) {
    const row = await db.order.create({ data: { restaurantId, tableId, ...fixture } });
    if (fixture.shortCode === "paid-today-opened-yesterday") carriedSale = row.id;
  }
  const other = await makeTenant();
  await db.order.create({ data: { ...other, shortCode: "foreign-sale", createdAt: since, paidAt: new Date("2026-09-29T23:00:00Z"), status: "paid" } });
});
afterAll(async () => {
  await db.restaurant.deleteMany({ where: { id: { in: tenantIds } } });
  await db.$disconnect();
});
describe("sales history on PostgreSQL", () => {
  it("shows yesterday's table under today's payment and orders all rows by displayed time", async () => {
    const rows = await history();
    expect(rows.map(r => r.shortCode)).toEqual(["paid-today-opened-yesterday", "new-unpaid", "legacy-paid-no-date", "cutoff-exact"]);
    expect(rows[0].id).toBe(carriedSale);
    expect(historyDate(rows[0]).toISOString()).toBe("2026-09-29T18:00:00.000Z");
    expect(rows.every(r => r.restaurantId === restaurantId)).toBe(true);
  });
  it("applies paid status and business cutoff to payment date, preserves undated legacy fallback", async () => {
    expect((await history("paid")).map(r => r.shortCode)).toEqual(["paid-today-opened-yesterday", "legacy-paid-no-date", "cutoff-exact"]);
    expect(await history(undefined, null)).toHaveLength(5);
  });
});
