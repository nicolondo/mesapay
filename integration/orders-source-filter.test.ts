import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { loadOrdersList } from "../src/lib/orders/ordersListQuery";
import { parseOrdersView } from "../src/lib/orders/ordersView";
const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["localhost", "127.0.0.1"].includes(database.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname)) throw new Error("Isolated local database required");
const day = "2026-11-09";
const tenantIds: string[] = [];
let restaurantId = "";
let table1 = "";
let table2 = "";
let foreignTable = "";
let manualTable = "";
const list = (params: Record<string, string> = {}, pageSize?: number) => loadOrdersList(restaurantId, parseOrdersView(params, day), 5, pageSize);
beforeAll(async () => {
  const r = await db.restaurant.create({ data: { name: "orders_source_review", slug: `orders-source-review-${randomUUID()}` } }); restaurantId = r.id; tenantIds.push(r.id);
  const other = await db.restaurant.create({ data: { name: "orders_source_review_other", slug: `orders-source-review-other-${randomUUID()}` } }); tenantIds.push(other.id);
  const makeTable = (restaurantId: string, number: number, kind: "standard" | "manual" | "pickup", label: string) => db.table.create({ data: { restaurantId, number, kind, label, qrToken: randomUUID() } });
  table1 = (await makeTable(r.id, 1, "standard", "Factura manual (etiqueta no define tipo)")).id;
  table2 = (await makeTable(r.id, 2, "standard", "Terraza")).id;
  manualTable = (await makeTable(r.id, -100, "manual", "Mesa 3 (etiqueta no define tipo)")).id;
  const pickup = (await makeTable(r.id, -1, "pickup", "Recogida")).id;
  foreignTable = (await makeTable(other.id, 1, "standard", "MESA AJENA")).id;
  for (const f of [
    { tableId: table1, shortCode: "SRC-T1-PAID", status: "paid" as const, totalCents: 10000, paidAt: new Date("2026-11-10T06:00:00Z") },
    { tableId: table1, shortCode: "SRC-T1-OPEN", status: "served" as const, totalCents: 0, paidAt: null },
    { tableId: table2, shortCode: "SRC-T2-PAID-7788", status: "paid" as const, totalCents: 20000, paidAt: new Date("2026-11-09T19:00:00Z") },
    { tableId: manualTable, shortCode: "SRC-MANUAL-PAID", status: "paid" as const, totalCents: 30000, paidAt: new Date("2026-11-09T20:00:00Z") },
    { tableId: manualTable, shortCode: "SRC-MANUAL-CANCEL", status: "cancelled" as const, totalCents: 0, paidAt: null },
    { tableId: pickup, shortCode: "SRC-PICKUP", status: "paid" as const, totalCents: 40000, paidAt: new Date("2026-11-09T20:00:00Z") },
  ]) await db.order.create({ data: { restaurantId, createdAt: new Date("2026-11-09T18:00:00Z"), ...f } });
  const oldManual = await db.order.create({ data: { restaurantId, tableId: manualTable, shortCode: "SRC-OLD-MANUAL", status: "paid", totalCents: 50000, createdAt: new Date("2026-10-01T18:00:00Z"), paidAt: new Date("2026-10-01T19:00:00Z") } });
  await db.simpleInvoice.create({ data: { restaurantId, orderId: oldManual.id, invoiceNumber: 7788, totalCents: 50000, snapshot: { invoicePrefix: "SYN" } } });
  const foreign = await db.order.create({ data: { restaurantId: other.id, tableId: foreignTable, shortCode: "FOREIGN-7788", status: "paid", totalCents: 999999, createdAt: new Date("2026-11-09T18:00:00Z"), paidAt: new Date("2026-11-09T20:00:00Z") } });
  await db.simpleInvoice.create({ data: { restaurantId: other.id, orderId: foreign.id, invoiceNumber: 7788, totalCents: 999999, snapshot: { invoicePrefix: "SYN" } } });
});
afterAll(async () => { await db.restaurant.deleteMany({ where: { id: { in: tenantIds } } }); await db.$disconnect(); });
describe("orders source filters with real PostgreSQL", () => {
  it("all sources preserves pickup while tables/manual follow actual Table.kind", async () => {
    expect((await list()).summary).toEqual({ count: 6, paidCount: 4, paidSum: 100000 });
    const tables = await list({ source: "tables" }); expect(tables.summary).toEqual({ count: 3, paidCount: 2, paidSum: 30000 }); expect(tables.rows.every((r) => r.table.kind === "standard")).toBe(true);
    const manual = await list({ source: "manual" }); expect(manual.summary).toEqual({ count: 2, paidCount: 1, paidSum: 30000 }); expect(manual.rows.every((r) => r.table.kind === "manual")).toBe(true);
  });
  it("filters a specific table and keeps operational-day payments after midnight", async () => {
    const result = await list({ source: "tables", tableId: table1 }); expect(result.rows.map((r) => r.shortCode)).toEqual(["SRC-T1-PAID", "SRC-T1-OPEN"]);
    expect(result.counts).toEqual({ all: 2, open: 1, paid: 1, cancelled: 0 }); expect(result.summary.paidSum).toBe(10000);
  });
  it("status counts keep source/table scope while summary follows selected state", async () => {
    const result = await list({ source: "manual", status: "paid" }); expect(result.summary.count).toBe(1); expect(result.counts).toEqual({ all: 2, open: 0, paid: 1, cancelled: 1 });
  });
  it("invoice-number pinning never bypasses source or table selection", async () => {
    const manual = await list({ q: "7788", source: "manual" }); expect(manual.rows.map((r) => r.shortCode)).toEqual(["SRC-OLD-MANUAL"]); expect(manual.summary.paidSum).toBe(50000); expect(manual.rows[0].matchedDocument).toBe(true);
    const tables = await list({ q: "7788", source: "tables" }); expect(tables.rows.map((r) => r.shortCode)).toEqual(["SRC-T2-PAID-7788"]); expect(tables.summary.paidSum).toBe(20000); expect(tables.rows[0].matchedDocument).toBe(false);
    expect((await list({ q: "SYN7788", source: "tables" })).rows).toEqual([]);
    expect((await list({ q: "7788", source: "tables", tableId: table1 })).summary.count).toBe(0);
  });
  it("foreign, missing or manual table ids fail closed", async () => {
    for (const tableId of [foreignTable, "missing-id", manualTable]) {
      const result = await list({ source: "tables", tableId, fechas: "todas", q: "7788" }); expect(result.rows).toEqual([]); expect(result.summary).toEqual({ count: 0, paidCount: 0, paidSum: 0 }); expect(result.counts.all).toBe(0);
    }
  });
  it("pagination and all-dates keep matching summary without duplicates", async () => {
    const one = await list({ source: "manual", fechas: "todas" }, 2); const two = await list({ source: "manual", fechas: "todas", page: "2" }, 2);
    expect(one.summary).toEqual({ count: 3, paidCount: 2, paidSum: 80000 }); expect(two.summary).toEqual(one.summary); expect(one.pageCount).toBe(2);
    expect(new Set([...one.rows, ...two.rows].map((r) => r.id)).size).toBe(3);
  });
});
