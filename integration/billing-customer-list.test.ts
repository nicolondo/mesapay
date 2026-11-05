import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import {
  CUSTOMER_PAGE_SIZE,
  DEFAULT_CUSTOMER_LIST_PARAMS,
  isChargeOverdue,
  type CustomerListParams,
} from "../src/lib/billingCustomerList";
import { loadBillingCustomerPage } from "../src/lib/billingCustomerListQueries";
import { loadCustomerCreditSummary } from "../src/lib/customerCredit";

/**
 * Regresión de "la lista de clientes no muestra todos los registros": la
 * API devolvía los primeros 50 por nombre (`take: 50`) y nada más. Con más
 * clientes que ese tope, todos tienen que poder alcanzarse paginando y
 * buscando, y los totales tienen que ser de la lista entera.
 */
const url = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["127.0.0.1", "localhost"].includes(url.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(url.pathname)) {
  throw new Error("Isolated local database required");
}

const OLD_CAP = 50;
const MANY = 123; // más que el tope viejo y que dos páginas
const TODAY = "2026-11-04";
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.parse(`${TODAY}T15:00:00Z`) - n * DAY);
const params = (p: Partial<CustomerListParams> = {}): CustomerListParams => ({ ...DEFAULT_CUSTOMER_LIST_PARAMS, ...p });

let restaurantId = "";
let otherRestaurantId = "";
const ids: Record<string, string> = {};

beforeAll(async () => {
  const token = randomUUID();
  restaurantId = (await db.restaurant.create({ data: { name: "Fixture lista clientes", slug: `lista-${token}` } })).id;
  otherRestaurantId = (await db.restaurant.create({ data: { name: "Fixture otro comercio", slug: `lista-otro-${token}` } })).id;

  // MANY clientes genéricos: la mitad empresas (NIT), la mitad personas.
  await db.billingCustomer.createMany({
    data: Array.from({ length: MANY }, (_, i) => ({
      restaurantId,
      customerName: `Cliente ${String(i + 1).padStart(3, "0")}`,
      docType: i % 2 === 0 ? ("NIT" as const) : ("CC" as const),
      docNumber: String(800_000_000 + i),
      email: `cliente${i + 1}@example.test`,
      createdAt: daysAgo(MANY - i),
    })),
  });
  // Uno que por nombre queda al final (más allá de los primeros 50).
  ids.last = (await db.billingCustomer.create({ data: { restaurantId, customerName: "Zuluaga Fixture", docType: "CE", docNumber: "E445566", email: "zuluaga@example.test" } })).id;
  // Documento que es prefijo de otros (1020304 ⊂ 1020304050…): el buscador
  // del cobro lo pone primero aunque por nombre vaya después.
  ids.exact = (await db.billingCustomer.create({ data: { restaurantId, customerName: "Zeta Documento Exacto", docType: "CC", docNumber: "1020304", email: "zeta@example.test" } })).id;
  // Clientes con crédito.
  ids.a = (await db.billingCustomer.create({ data: { restaurantId, customerName: "Crédito A", docType: "NIT", docNumber: "901944469", verificationDigit: "1", email: "a@example.test", creditEnabled: true, creditTermsDays: 30 } })).id;
  ids.b = (await db.billingCustomer.create({ data: { restaurantId, customerName: "Crédito B", docType: "CC", docNumber: "1020304050", email: "b@example.test", creditEnabled: true, creditTermsDays: 15 } })).id;
  ids.c = (await db.billingCustomer.create({ data: { restaurantId, customerName: "Crédito C sin cargos", docType: "CC", docNumber: "1020304051", email: "c@example.test", creditEnabled: true } })).id;
  // Crédito apagado después de quedar debiendo: sigue apareciendo con deuda.
  ids.d = (await db.billingCustomer.create({ data: { restaurantId, customerName: "Crédito D apagado", docType: "CC", docNumber: "1020304052", email: "d@example.test", creditEnabled: false, creditTermsDays: 30, discountEnabled: true, discountBps: 1000 } })).id;
  // Mismo documento y nombre parecido en OTRO comercio: nunca debe aparecer.
  ids.foreign = (await db.billingCustomer.create({ data: { restaurantId: otherRestaurantId, customerName: "Crédito A ajeno", docType: "NIT", docNumber: "901944469", verificationDigit: "1", email: "a@example.test", creditEnabled: true } })).id;

  const table = await db.table.create({ data: { restaurantId, number: 1, qrToken: randomUUID() } });
  const otherTable = await db.table.create({ data: { restaurantId: otherRestaurantId, number: 1, qrToken: randomUUID() } });
  async function charge(customerId: string, amountCents: number, at: Date, extra: { refundedCents?: number; tableId?: string; restaurant?: string } = {}) {
    const order = await db.order.create({ data: { restaurantId: extra.restaurant ?? restaurantId, tableId: extra.tableId ?? table.id, shortCode: randomUUID(), status: "paid", subtotalCents: amountCents, totalCents: amountCents } });
    await db.payment.create({ data: { orderId: order.id, method: "customer_credit", status: "approved", amountCents, refundedCents: extra.refundedCents ?? 0, billingCustomerId: customerId, createdAt: at, settledAt: at } });
  }
  async function abono(customerId: string, amountCents: number, at: Date, restaurant = restaurantId) {
    await db.customerCreditPayment.create({ data: { restaurantId: restaurant, billingCustomerId: customerId, amountCents, paidAt: at, accountCode: "110505" } });
  }
  // A: 100.000 hace 60 días (vencido a 30), 50.000 hace 5 (al día), abono 30.000.
  await charge(ids.a, 100_000_00, daysAgo(60));
  await charge(ids.a, 50_000_00, daysAgo(5));
  await abono(ids.a, 30_000_00, daysAgo(2));
  // B: 80.000 hace 40 días con plazo 15 (vencido), 20.000 con 5.000 devueltos hace 3.
  await charge(ids.b, 80_000_00, daysAgo(40));
  await charge(ids.b, 20_000_00, daysAgo(3), { refundedCents: 5_000_00 });
  // D: 10.000 hace 90 días (vencido), sin abonos.
  await charge(ids.d, 10_000_00, daysAgo(90));
  // Cargo ajeno sobre un cliente del otro comercio: no suma acá.
  await charge(ids.foreign, 999_000_00, daysAgo(90), { tableId: otherTable.id, restaurant: otherRestaurantId });
  await abono(ids.foreign, 1_000_00, daysAgo(1), otherRestaurantId);
});

afterAll(async () => {
  await db.restaurant.deleteMany({ where: { id: { in: [restaurantId, otherRestaurantId] } } });
  await db.$disconnect();
});

const TOTAL = MANY + 6;

describe("billing customer list on PostgreSQL", () => {
  it("reaches every client by paging, past the old 50-row cap, in a stable order", async () => {
    expect(TOTAL).toBeGreaterThan(OLD_CAP);
    const seen: string[] = [];
    const first = await loadBillingCustomerPage(restaurantId, params(), { today: TODAY });
    expect(first.total).toBe(TOTAL);
    expect(first.allCount).toBe(TOTAL);
    expect(first.pageCount).toBe(Math.ceil(TOTAL / CUSTOMER_PAGE_SIZE));
    for (let page = 1; page <= first.pageCount; page++) {
      const p = await loadBillingCustomerPage(restaurantId, params({ page }), { today: TODAY });
      expect(p.from).toBe((page - 1) * CUSTOMER_PAGE_SIZE + 1);
      expect(p.to).toBe(Math.min(TOTAL, page * CUSTOMER_PAGE_SIZE));
      seen.push(...p.rows.map((r) => r.id));
    }
    expect(seen).toHaveLength(TOTAL);
    expect(new Set(seen).size).toBe(TOTAL);
    expect(seen).toContain(ids.last);
    expect(seen).not.toContain(ids.foreign);
    // Orden por nombre: "Zuluaga" es el último.
    expect(seen[seen.length - 1]).toBe(ids.last);
  });

  it("finds a client beyond the first 50 by name, email and formatted document", async () => {
    for (const q of ["zuluaga", "ZULUAGA@example", "E445566", "Cliente 117"]) {
      const p = await loadBillingCustomerPage(restaurantId, params({ q }), { today: TODAY });
      expect(p.rows.map((r) => r.customerName)).toEqual([q === "Cliente 117" ? "Cliente 117" : "Zuluaga Fixture"]);
    }
    const nit = await loadBillingCustomerPage(restaurantId, params({ q: "901.944.469-1" }), { today: TODAY });
    expect(nit.rows.map((r) => r.id)).toEqual([ids.a]);
    // Los comodines de LIKE se buscan literales.
    expect((await loadBillingCustomerPage(restaurantId, params({ q: "%" }), { today: TODAY })).total).toBe(0);
    // Una búsqueda amplia pagina igual: "Cliente" coincide con los MANY genéricos.
    const broad = await loadBillingCustomerPage(restaurantId, params({ q: "cliente", page: 3 }), { today: TODAY });
    expect(broad.total).toBe(MANY);
    expect(broad.rows).toHaveLength(MANY - 2 * CUSTOMER_PAGE_SIZE);
  });

  it("computes debt and FIFO overdue like the credit statement and Cartera", async () => {
    const p = await loadBillingCustomerPage(restaurantId, params({ status: "debt", sort: "debt" }), { today: TODAY });
    expect(p.rows.map((r) => r.id)).toEqual([ids.a, ids.b, ids.d]);
    const byId = new Map(p.rows.map((r) => [r.id, r]));
    expect(byId.get(ids.a)).toMatchObject({ debtCents: 120_000_00, overdueCents: 70_000_00 });
    expect(byId.get(ids.b)).toMatchObject({ debtCents: 95_000_00, overdueCents: 80_000_00 });
    expect(byId.get(ids.d)).toMatchObject({ debtCents: 10_000_00, overdueCents: 10_000_00 });
    // Mismo resultado que el estado de cuenta (allocateFifo) con el vencimiento de Cartera.
    for (const id of [ids.a, ids.b, ids.d]) {
      const statement = await loadCustomerCreditSummary(restaurantId, id);
      expect(statement).not.toBeNull();
      const dates = new Map(statement!.charges.map((c) => [c.id, c.date]));
      const overdue = statement!.fifo.charges
        .filter((c) => isChargeOverdue(dates.get(c.chargeId)!, statement!.customer.creditTermsDays, TODAY))
        .reduce((s, c) => s + c.outstandingCents, 0);
      expect(byId.get(id)).toMatchObject({ debtCents: statement!.debtCents, overdueCents: overdue });
    }
  });

  it("summarizes the whole filtered set, not the visible page", async () => {
    const all = await loadBillingCustomerPage(restaurantId, params(), { today: TODAY });
    expect(all.usesCredit).toBe(true);
    expect(all.summary).toEqual({
      count: TOTAL,
      creditCount: 3,
      debtorCount: 3,
      overdueCount: 3,
      debtCents: 225_000_00,
      overdueCents: 160_000_00,
    });
    const people = await loadBillingCustomerPage(restaurantId, params({ type: "person" }), { today: TODAY });
    expect(people.summary).toMatchObject({ creditCount: 2, debtCents: 105_000_00, overdueCents: 90_000_00 });
    expect(people.rows.every((r) => r.docType !== "NIT")).toBe(true);
    const companies = await loadBillingCustomerPage(restaurantId, params({ type: "company" }), { today: TODAY });
    expect(companies.total).toBe(Math.ceil(MANY / 2) + 1);
    expect(companies.rows.every((r) => r.docType === "NIT")).toBe(true);
  });

  it("filters by credit, overdue and discount, and the picker's credit-only mode", async () => {
    const ofStatus = async (status: CustomerListParams["status"]) =>
      (await loadBillingCustomerPage(restaurantId, params({ status }), { today: TODAY })).rows.map((r) => r.id).sort();
    expect(await ofStatus("credit")).toEqual([ids.a, ids.b, ids.c].sort());
    expect(await ofStatus("overdue")).toEqual([ids.a, ids.b, ids.d].sort());
    expect(await ofStatus("discount")).toEqual([ids.d]);
    // Nada vence todavía si "hoy" es el día del primer cargo.
    const early = await loadBillingCustomerPage(restaurantId, params({ status: "overdue" }), { today: daysAgo(90).toISOString().slice(0, 10) });
    expect(early.total).toBe(0);
    const picker = await loadBillingCustomerPage(restaurantId, params({ q: "crédito" }), { creditOnly: true, today: TODAY });
    expect(picker.rows.map((r) => r.id).sort()).toEqual([ids.a, ids.b, ids.c].sort());
  });

  it("puts the exact document first when the picker sorts by relevance", async () => {
    const byName = await loadBillingCustomerPage(restaurantId, params({ q: "1020304" }), { today: TODAY });
    expect(byName.rows.map((r) => r.id)).toEqual([ids.b, ids.c, ids.d, ids.exact]);
    const p = await loadBillingCustomerPage(restaurantId, params({ q: "1020304", sort: "relevance" }), { pageSize: 2, today: TODAY });
    expect(p.total).toBe(4);
    expect(p.rows.map((r) => r.id)).toEqual([ids.exact, ids.b]);
  });

  it("clamps a page past the end to the last page and sorts by most recent", async () => {
    const past = await loadBillingCustomerPage(restaurantId, params({ page: 999 }), { today: TODAY });
    expect(past.page).toBe(past.pageCount);
    expect(past.rows.length).toBe(TOTAL - (past.pageCount - 1) * CUSTOMER_PAGE_SIZE);
    const recent = await loadBillingCustomerPage(restaurantId, params({ sort: "recent" }), { pageSize: 3, today: TODAY });
    const created = recent.rows.map((r) => r.createdAt);
    expect([...created].sort().reverse()).toEqual(created);
  });

  it("returns an empty, zeroed page for a restaurant without clients", async () => {
    const empty = await db.restaurant.create({ data: { name: "Fixture vacío", slug: `lista-vacio-${randomUUID()}` } });
    try {
      const p = await loadBillingCustomerPage(empty.id, params(), { today: TODAY });
      expect(p).toMatchObject({ rows: [], total: 0, page: 1, pageCount: 1, from: 0, to: 0, usesCredit: false, allCount: 0 });
    } finally {
      await db.restaurant.delete({ where: { id: empty.id } });
    }
  });
});
