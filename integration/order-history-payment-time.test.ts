import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { historyDate } from "../src/lib/orders/history";
import { loadOrdersList } from "../src/lib/orders/ordersListQuery";
import type { OrdersView } from "../src/lib/orders/ordersView";

const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["localhost", "127.0.0.1"].includes(database.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname)) throw new Error("Isolated local database required");

const CUTOFF = 5;
const DAY = "2026-09-29"; // Día de negocio: 2026-09-29T10:00Z → 2026-09-30T10:00Z.
const tenantIds: string[] = [];
const seriesIds: string[] = [];
let restaurantId: string;
let tableId: string;
let carriedSale: string;
let invoicedOrder: string;

const view = (patch: Partial<OrdersView> = {}): OrdersView => ({
  status: "all", q: "", period: { desde: DAY, hasta: DAY }, allDates: false, page: 1, ...patch,
});
const codes = async (patch: Partial<OrdersView> = {}, pageSize?: number) =>
  (await loadOrdersList(restaurantId, view(patch), CUTOFF, pageSize)).rows.map((r) => r.shortCode);

async function makeTenant() {
  const restaurant = await db.restaurant.create({ data: { name: "History test only", slug: `history-${randomUUID()}` } });
  tenantIds.push(restaurant.id);
  const table = await db.table.create({ data: { restaurantId: restaurant.id, number: 1, qrToken: randomUUID() } });
  return { restaurantId: restaurant.id, tableId: table.id };
}

beforeAll(async () => {
  ({ restaurantId, tableId } = await makeTenant());
  const fixtures = [
    { shortCode: "paid-today-opened-yesterday", createdAt: new Date("2026-09-28T15:00:00Z"), paidAt: new Date("2026-09-29T18:00:00Z"), status: "paid" as const, totalCents: 10_000 },
    { shortCode: "new-unpaid", createdAt: new Date("2026-09-29T17:00:00Z"), paidAt: null, status: "served" as const, totalCents: 0 },
    { shortCode: "previous-business-day", createdAt: new Date("2026-09-28T15:00:00Z"), paidAt: new Date("2026-09-29T09:59:59Z"), status: "paid" as const, totalCents: 99_000 },
    { shortCode: "legacy-paid-no-date", createdAt: new Date("2026-09-29T12:00:00Z"), paidAt: null, status: "paid" as const, totalCents: 2_000 },
    { shortCode: "cutoff-exact", createdAt: new Date("2026-09-28T15:00:00Z"), paidAt: new Date("2026-09-29T10:00:00Z"), status: "paid" as const, totalCents: 3_000 },
    { shortCode: "after-the-night", createdAt: new Date("2026-09-30T02:00:00Z"), paidAt: new Date("2026-09-30T09:59:59Z"), status: "paid" as const, totalCents: 4_000 },
    { shortCode: "next-business-day", createdAt: new Date("2026-09-30T10:00:00Z"), paidAt: null, status: "cancelled" as const, totalCents: 0 },
  ];
  for (const fixture of fixtures) {
    const row = await db.order.create({ data: { restaurantId, tableId, ...fixture } });
    if (fixture.shortCode === "paid-today-opened-yesterday") carriedSale = row.id;
  }
  // Una factura de hace un mes (FESM7913) y su nota crédito NC12.
  const old = await db.order.create({ data: { restaurantId, tableId, shortCode: "AB7913-invoiced-long-ago", status: "paid", createdAt: new Date("2026-08-20T20:00:00Z"), paidAt: new Date("2026-08-20T21:00:00Z"), totalCents: 50_000 } });
  invoicedOrder = old.id;
  const invoice = await db.simpleInvoice.create({ data: { restaurantId, orderId: old.id, invoiceNumber: 7913, totalCents: 50_000, snapshot: { invoicePrefix: "FESM" } } });
  const series = await db.creditNoteSeries.create({ data: { issuerNit: `9${Date.now()}`.slice(0, 10), environment: "2", prefix: "NC" } });
  seriesIds.push(series.id);
  await db.creditNote.create({ data: { fiscalKey: `history-${randomUUID()}`, restaurantId, originalInvoiceId: invoice.id, seriesId: series.id, number: 12, documentNumber: "NC12", requestId: randomUUID(), requestHash: "h", reasonCode: "2", reasonText: "Anulación", snapshot: { version: 1 }, subtotalCents: 50_000, taxCents: 0, totalCents: 50_000 } });

  // Otro comercio con el mismo número de factura y su venta del día: nunca se ve.
  const other = await makeTenant();
  const foreign = await db.order.create({ data: { ...other, shortCode: "foreign-sale", createdAt: new Date("2026-09-29T12:00:00Z"), paidAt: new Date("2026-09-29T23:00:00Z"), status: "paid", totalCents: 1 } });
  await db.simpleInvoice.create({ data: { restaurantId: other.restaurantId, orderId: foreign.id, invoiceNumber: 7913, totalCents: 1, snapshot: { invoicePrefix: "FESM" } } });
});

afterAll(async () => {
  await db.creditNote.deleteMany({ where: { restaurantId: { in: tenantIds } } });
  await db.restaurant.deleteMany({ where: { id: { in: tenantIds } } });
  await db.creditNoteSeries.deleteMany({ where: { id: { in: seriesIds } } });
  await db.$disconnect();
});

describe("lista de Órdenes sobre PostgreSQL", () => {
  it("un día de negocio: la cuenta de ayer cobrada hoy, ordenado por el instante que se muestra", async () => {
    const list = await loadOrdersList(restaurantId, view(), CUTOFF);
    expect(list.rows.map((r) => r.shortCode)).toEqual([
      "after-the-night", "paid-today-opened-yesterday", "new-unpaid", "legacy-paid-no-date", "cutoff-exact",
    ]);
    expect(list.rows[1].id).toBe(carriedSale);
    expect(historyDate(list.rows[1]).toISOString()).toBe("2026-09-29T18:00:00.000Z");
    expect(list.rows.every((r) => r.restaurantId === restaurantId)).toBe(true);
    expect(list.scope).toBe("period");
  });

  it("totales y contadores del período, por estado", async () => {
    const list = await loadOrdersList(restaurantId, view(), CUTOFF);
    expect(list.summary).toEqual({ count: 5, paidCount: 4, paidSum: 19_000 });
    expect(list.counts).toEqual({ all: 5, open: 1, paid: 4, cancelled: 0 });
    const paid = await loadOrdersList(restaurantId, view({ status: "paid" }), CUTOFF);
    expect(paid.rows.map((r) => r.shortCode)).toEqual(["after-the-night", "paid-today-opened-yesterday", "legacy-paid-no-date", "cutoff-exact"]);
    // Los chips cuentan igual con cualquier estado elegido.
    expect(paid.counts).toEqual(list.counts);
    expect(paid.summary).toEqual({ count: 4, paidCount: 4, paidSum: 19_000 });
  });

  it("una semana incluye los días vecinos; todas las fechas, todo el comercio", async () => {
    expect(await codes({ period: { desde: "2026-09-28", hasta: "2026-10-04" } })).toEqual([
      "next-business-day", "after-the-night", "paid-today-opened-yesterday", "new-unpaid", "legacy-paid-no-date", "cutoff-exact", "previous-business-day",
    ]);
    expect(await codes({ allDates: true })).toHaveLength(8);
  });

  it("paginación: páginas sin solaparse, totales iguales en cada página, página de más → la última", async () => {
    const pages = await Promise.all([1, 2, 3].map((page) => loadOrdersList(restaurantId, view({ page }), CUTOFF, 2)));
    expect(pages.map((p) => p.rows.map((r) => r.shortCode))).toEqual([
      ["after-the-night", "paid-today-opened-yesterday"],
      ["new-unpaid", "legacy-paid-no-date"],
      ["cutoff-exact"],
    ]);
    expect(new Set(pages.map((p) => JSON.stringify(p.summary))).size).toBe(1);
    expect(pages.every((p) => p.pageCount === 3)).toBe(true);
    const beyond = await loadOrdersList(restaurantId, view({ page: 9 }), CUTOFF, 2);
    expect(beyond.page).toBe(3);
    expect(beyond.rows.map((r) => r.shortCode)).toEqual(["cutoff-exact"]);
  });

  it("búsqueda por código: junto con el período", async () => {
    expect(await codes({ q: "UNPAID" })).toEqual(["new-unpaid"]);
    expect(await codes({ q: "invoiced" })).toEqual([]);
  });

  it("el número solo trae la orden de la factura ARRIBA y debajo los códigos que lo contienen", async () => {
    const extra = await db.order.create({ data: { restaurantId, tableId, shortCode: "CC7913-code-match-newer", status: "paid", createdAt: new Date("2026-10-01T20:00:00Z"), paidAt: new Date("2026-10-01T21:00:00Z"), totalCents: 7_000 } });
    try {
      const list = await loadOrdersList(restaurantId, view({ q: "7913" }), CUTOFF);
      expect(list.rows.map((r) => r.shortCode)).toEqual(["AB7913-invoiced-long-ago", "CC7913-code-match-newer"]);
      expect(list.rows.map((r) => r.matchedDocument)).toEqual([true, false]);
      expect(list.summary).toEqual({ count: 2, paidCount: 2, paidSum: 57_000 });
      // Con prefijo, sólo la factura.
      expect(await codes({ q: "FESM7913" })).toEqual(["AB7913-invoiced-long-ago"]);
      // Página de a 1: la factura en la 1, el código en la 2.
      expect((await loadOrdersList(restaurantId, view({ q: "7913", page: 2 }), CUTOFF, 1)).rows.map((r) => r.shortCode)).toEqual(["CC7913-code-match-newer"]);
    } finally {
      await db.order.delete({ where: { id: extra.id } });
    }
  });

  it("búsqueda por número de factura o nota crédito: en todas las fechas y sólo de este comercio", async () => {
    for (const q of ["FESM7913", "fesm 7913", "FESM-07913", "7913", "NC12", "nc-12"]) {
      const list = await loadOrdersList(restaurantId, view({ q }), CUTOFF);
      expect(list.scope, q).toBe("all");
      expect(list.rows.map((r) => r.id), q).toEqual([invoicedOrder]);
      expect(list.rows[0].invoicePrefix).toBe("FESM");
    }
    // Otro prefijo, otro número u otro estado: nada.
    expect(await codes({ q: "POS7913" })).toEqual([]);
    expect(await codes({ q: "FESM7914" })).toEqual([]);
    expect(await codes({ q: "7913", status: "open" })).toEqual([]);
  });
});
