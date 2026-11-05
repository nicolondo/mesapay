import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { DEFAULT_DINER_LIST_PARAMS, DINER_PAGE_SIZE, type DinerListParams } from "../src/lib/dinerList";
import { loadDinerPage } from "../src/lib/dinerListQueries";

/**
 * Regresión de la pestaña "Comensales registrados": antes se traían los 500
 * registros más recientes y se ordenaban por consumo en memoria, así que el
 * comensal más viejo —aunque fuera el que más consumió— quedaba fuera.
 */
const url = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["127.0.0.1", "localhost"].includes(url.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(url.pathname)) {
  throw new Error("Isolated local database required");
}

const OLD_CAP = 500;
const MANY = OLD_CAP + 7;
const params = (p: Partial<DinerListParams> = {}): DinerListParams => ({ ...DEFAULT_DINER_LIST_PARAMS, ...p });
let restaurantId = "";
let otherRestaurantId = "";
let veteranId = "";

beforeAll(async () => {
  const token = randomUUID();
  restaurantId = (await db.restaurant.create({ data: { name: "Fixture comensales", slug: `comensales-${token}` } })).id;
  otherRestaurantId = (await db.restaurant.create({ data: { name: "Fixture comensales otro", slug: `comensales-otro-${token}` } })).id;
  // El primero en registrarse es el que más consume.
  const veteran = await db.diner.create({ data: { restaurantId, email: "veterano@example.test", name: "Comensal Veterano", cedula: "77889900", passwordHash: "x", createdAt: new Date("2025-01-01T12:00:00Z") } });
  veteranId = veteran.id;
  await db.diner.createMany({
    data: Array.from({ length: MANY - 1 }, (_, i) => ({
      restaurantId,
      email: `comensal${i}@example.test`,
      name: `Comensal ${String(i).padStart(3, "0")}`,
      passwordHash: "x",
      createdAt: new Date(Date.parse("2026-01-01T12:00:00Z") + i * 60_000),
    })),
  });
  await db.diner.create({ data: { restaurantId: otherRestaurantId, email: "veterano@example.test", name: "Comensal Veterano ajeno", passwordHash: "x" } });
  const table = await db.table.create({ data: { restaurantId, number: 1, qrToken: randomUUID() } });
  for (const totalCents of [120_000_00, 80_000_00]) {
    await db.order.create({ data: { restaurantId, tableId: table.id, dinerId: veteranId, shortCode: randomUUID(), status: "paid", subtotalCents: totalCents, totalCents } });
  }
  // Una cuenta sin pagar no suma consumo.
  await db.order.create({ data: { restaurantId, tableId: table.id, dinerId: veteranId, shortCode: randomUUID(), status: "placed", subtotalCents: 5_000_00, totalCents: 5_000_00 } });
  await db.dinerDiscount.create({ data: { dinerId: veteranId, percent: 15, active: true } });
});

afterAll(async () => {
  await db.restaurant.deleteMany({ where: { id: { in: [restaurantId, otherRestaurantId] } } });
  await db.$disconnect();
});

describe("diner list on PostgreSQL", () => {
  it("keeps the oldest top spender on top and reaches every diner by paging", async () => {
    const first = await loadDinerPage(restaurantId, params());
    expect(first.total).toBe(MANY);
    expect(first.rows[0]).toMatchObject({ id: veteranId, orders: 2, totalCents: 200_000_00, discountPct: 15 });
    expect(first.summary).toEqual({ count: MANY, withOrders: 1, totalCents: 200_000_00 });
    const seen = new Set<string>();
    for (let page = 1; page <= first.pageCount; page++) {
      for (const r of (await loadDinerPage(restaurantId, params({ page }))).rows) seen.add(r.id);
    }
    expect(seen.size).toBe(MANY);
    expect(first.pageCount).toBe(Math.ceil(MANY / DINER_PAGE_SIZE));
  });

  it("searches by partial name, email or formatted cedula within the restaurant only", async () => {
    for (const q of ["veterano", "VETERANO@EXAMPLE", "77.889"]) {
      const p = await loadDinerPage(restaurantId, params({ q }));
      expect(p.rows.map((r) => r.id)).toEqual([veteranId]);
    }
    expect((await loadDinerPage(restaurantId, params({ q: "comensal 50" }))).total).toBe(6); // 500–505
  });

  it("sorts by most recent and by name with stable paging", async () => {
    const recent = await loadDinerPage(restaurantId, params({ sort: "recent" }), { pageSize: 3 });
    expect(recent.rows.map((r) => r.name)).toEqual(["Comensal 505", "Comensal 504", "Comensal 503"]);
    const byName = await loadDinerPage(restaurantId, params({ sort: "name", page: 2 }), { pageSize: 2 });
    expect(byName.rows.map((r) => r.name)).toEqual(["Comensal 002", "Comensal 003"]);
  });
});
