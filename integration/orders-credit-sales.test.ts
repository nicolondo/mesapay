// «A crédito» / «Crédito pagado» en Órdenes, contra PostgreSQL real: el
// filtro credito=1 de la lista y el estado de cada venta según los abonos
// del cliente (FIFO, como Cartera).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { loadOrdersList } from "../src/lib/orders/ordersListQuery";
import { loadCreditSales } from "../src/lib/orders/creditSaleQuery";
import { parseOrdersView } from "../src/lib/orders/ordersView";

const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["localhost", "127.0.0.1"].includes(database.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname)) throw new Error("Isolated local database required");

const day = "2026-11-09";
const tenantIds: string[] = [];
let restaurantId = "";
let otherRestaurantId = "";
const ids: Record<string, string> = {};
const list = (params: Record<string, string> = {}) => loadOrdersList(restaurantId, parseOrdersView(params, day), 5);

beforeAll(async () => {
  const r = await db.restaurant.create({ data: { name: "orders_credit_fixture", slug: `orders-credit-${randomUUID()}` } });
  const other = await db.restaurant.create({ data: { name: "orders_credit_other", slug: `orders-credit-other-${randomUUID()}` } });
  restaurantId = r.id; otherRestaurantId = other.id; tenantIds.push(r.id, other.id);
  const table = await db.table.create({ data: { restaurantId, number: 1, qrToken: randomUUID() } });
  const customer = (name: string, docNumber: string) =>
    db.billingCustomer.create({ data: { restaurantId, customerName: name, docType: "NIT", docNumber, email: `${docNumber}@example.test`, creditEnabled: true } });
  const acme = await customer("Fixture Acme", "900000001");
  const beta = await customer("Fixture Beta", "900000002");

  const order = async (shortCode: string, paidAt: string, totalCents: number) => {
    const o = await db.order.create({
      data: { restaurantId, tableId: table.id, shortCode, status: "paid", subtotalCents: totalCents, totalCents, createdAt: new Date(paidAt), paidAt: new Date(paidAt) },
    });
    ids[shortCode] = o.id;
    return o.id;
  };
  const pay = (orderId: string, method: "cash" | "customer_credit", amountCents: number, settledAt: string, billingCustomerId?: string) =>
    db.payment.create({ data: { orderId, method, status: "approved", amountCents, settledAt: new Date(settledAt), billingCustomerId } });

  // Vieja (fuera del día) a crédito de Acme: 80.000.
  await pay(await order("CR-OLD", "2026-10-01T18:00:00Z", 80_000), "customer_credit", 80_000, "2026-10-01T18:00:00Z", acme.id);
  // Hoy, toda a crédito de Acme: 50.000.
  await pay(await order("CR-FULL", "2026-11-09T18:00:00Z", 50_000), "customer_credit", 50_000, "2026-11-09T18:00:00Z", acme.id);
  // Hoy, mitad efectivo y mitad a crédito de Beta, que ya la pagó.
  const mixed = await order("CR-MIXED", "2026-11-09T19:00:00Z", 60_000);
  await pay(mixed, "cash", 30_000, "2026-11-09T19:00:00Z");
  await pay(mixed, "customer_credit", 30_000, "2026-11-09T19:00:00Z", beta.id);
  // Hoy, en efectivo: no es venta a crédito.
  await pay(await order("CASH-ONLY", "2026-11-09T20:00:00Z", 40_000), "cash", 40_000, "2026-11-09T20:00:00Z");

  // Abonos: Acme paga 100.000 (salda la vieja y deja 30.000 de CR-FULL); Beta 30.000.
  await db.customerCreditPayment.create({ data: { restaurantId, billingCustomerId: acme.id, amountCents: 100_000, paidAt: new Date("2026-11-10T15:00:00Z"), accountCode: "110505" } });
  await db.customerCreditPayment.create({ data: { restaurantId, billingCustomerId: beta.id, amountCents: 30_000, paidAt: new Date("2026-11-10T15:00:00Z"), accountCode: "110505" } });
});

afterAll(async () => { await db.restaurant.deleteMany({ where: { id: { in: tenantIds } } }); await db.$disconnect(); });

describe("ventas a crédito en Órdenes con PostgreSQL", () => {
  it("credito=1 deja sólo las cuentas con un cobro a crédito, con sus totales y contadores", async () => {
    const all = await list();
    expect(all.rows.map((r) => r.shortCode).sort()).toEqual(["CASH-ONLY", "CR-FULL", "CR-MIXED"]);
    const credit = await list({ credito: "1" });
    expect(credit.rows.map((r) => r.shortCode).sort()).toEqual(["CR-FULL", "CR-MIXED"]);
    expect(credit.summary).toEqual({ count: 2, paidCount: 2, paidSum: 110_000 });
    expect(credit.counts).toEqual({ all: 2, open: 0, paid: 2, cancelled: 0 });
    // La fila trae el método de sus pagos (para no consultar Cartera si no hace falta).
    expect(credit.rows.find((r) => r.shortCode === "CR-MIXED")?.payments.map((p) => p.method).sort()).toEqual(["cash", "customer_credit"]);
    expect((await list({ credito: "1", fechas: "todas" })).summary.count).toBe(3);
  });

  it("el estado de cada venta sigue el FIFO de los abonos del cliente", async () => {
    const sales = await loadCreditSales(restaurantId, [ids["CR-OLD"], ids["CR-FULL"], ids["CR-MIXED"], ids["CASH-ONLY"]]);
    expect(sales.get(ids["CR-OLD"])).toMatchObject({ status: "credit_paid", outstandingCents: 0, customerName: "Fixture Acme" });
    expect(sales.get(ids["CR-FULL"])).toMatchObject({ status: "on_credit", creditCents: 50_000, outstandingCents: 30_000 });
    expect(sales.get(ids["CR-MIXED"])).toMatchObject({ status: "credit_paid", creditCents: 30_000, outstandingCents: 0, customerName: "Fixture Beta" });
    expect(sales.has(ids["CASH-ONLY"])).toBe(false);
    // Sólo la cuenta pedida, aunque el FIFO use toda la historia del cliente.
    expect([...(await loadCreditSales(restaurantId, [ids["CR-FULL"]])).keys()]).toEqual([ids["CR-FULL"]]);
  });

  it("no cruza comercios", async () => {
    expect((await loadCreditSales(otherRestaurantId, [ids["CR-FULL"]])).size).toBe(0);
    expect((await loadCreditSales(restaurantId, [])).size).toBe(0);
  });
});
