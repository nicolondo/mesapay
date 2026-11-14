// Una FACTURA MANUAL nunca es una cuenta abierta del salón, en ningún
// estado (borrador, enviada con link, emitida por cobrar, cobrada), contra
// PostgreSQL real: no sale en Mesas, «Mesas en vivo» del datáfono, el
// Resumen (abiertas ahora, lo que falta cobrar) ni el cierre de turno; el
// pagador remoto no puede pedir efectivo ni datáfono (lo que la llevaría
// al Salón). Sí sale en Facturas manuales (pendientes).
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/lib/db";
import { openManualInvoiceInTx, OPEN_ORDER_STATUS_FILTER } from "../src/lib/manualInvoice";
import { floorTablesOf, pendingManualInvoiceCount, terminalTablesWhere } from "../src/lib/tables/salonTables";
import { dashboardOpenOrdersWhere, loadDashboardUncollected } from "../src/lib/reports/dashboardSalesQuery";
import { listOpenOrders } from "../src/lib/shift";
import { POST as payCash } from "../src/app/api/tenant/[slug]/pay/route";
import { POST as externalTerminal } from "../src/app/api/tenant/[slug]/pay/external-terminal-request/route";

vi.mock("../src/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
// Sin sesión de staff: es el cliente que abrió el link.
vi.mock("../src/auth", () => ({ auth: async () => null }));
vi.mock("../src/lib/activeRestaurant", () => ({
  getActiveRestaurantId: async () => null,
  getActiveContext: async () => null,
}));
vi.mock("../src/lib/events", () => ({ publishOrderEvent: vi.fn() }));
vi.mock("../src/lib/push", () => ({ sendPushToMeserosForTable: vi.fn(async () => undefined) }));
vi.mock("../src/lib/billRequest", () => ({ announceBillRequestedOnPay: vi.fn(async () => undefined) }));

const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["localhost", "127.0.0.1"].includes(database.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname)) {
  throw new Error("Isolated local database required");
}

const tenants: string[] = [];
let restaurantId = "";
let slug = "";
const ids: Record<string, string> = {};

async function manualOrder(): Promise<{ orderId: string; tableId: string }> {
  const opened = await db.$transaction((tx) => openManualInvoiceInTx(tx, { restaurantId, locale: "es" }));
  await db.orderItem.create({
    data: { orderId: opened.orderId, nameSnapshot: "Catering", priceCentsSnapshot: 500_000, qty: 1, servedAt: new Date() },
  });
  await db.order.update({ where: { id: opened.orderId }, data: { subtotalCents: 500_000, totalCents: 500_000 } });
  return { orderId: opened.orderId, tableId: opened.tableId };
}

beforeEach(async () => {
  const tenant = await db.restaurant.create({
    data: { name: "Salón sin manuales", slug: `salon-${randomUUID()}`, salesTaxKind: "none", salesTaxPct: 0 },
  });
  tenants.push(tenant.id);
  restaurantId = tenant.id;
  slug = tenant.slug;
  const mesa = await db.table.create({ data: { restaurantId, number: 1, qrToken: randomUUID() } });
  ids.mesa = mesa.id;
  ids.mesaOrder = (
    await db.order.create({
      data: { restaurantId, tableId: mesa.id, shortCode: randomUUID(), status: "served", subtotalCents: 300_000, totalCents: 300_000 },
    })
  ).id;

  // Borrador: abierta, sin link.
  const draft = await manualOrder();
  ids.draft = draft.orderId;
  // Enviada sólo con el link: abierta, con link.
  const sent = await manualOrder();
  ids.sent = sent.orderId;
  await db.paymentLink.create({
    data: { restaurantId, token: randomUUID(), kind: "order", orderId: sent.orderId, amountCents: 500_000, emailSentAt: new Date(), payerEmail: "a@e.test" },
  });
  // Emitida por cobrar: cerrada a crédito del cliente, link al cargo.
  const receivable = await manualOrder();
  ids.receivable = receivable.orderId;
  const customer = await db.billingCustomer.create({
    data: { restaurantId, customerName: "Cliente", docType: "NIT", docNumber: "900123456", email: "c@e.test" },
  });
  const charge = await db.payment.create({
    data: { orderId: receivable.orderId, method: "customer_credit", status: "approved", amountCents: 500_000, billingCustomerId: customer.id, settledAt: new Date() },
  });
  await db.order.update({ where: { id: receivable.orderId }, data: { status: "paid", paidAt: new Date() } });
  await db.paymentLink.create({
    data: { restaurantId, token: randomUUID(), kind: "order", orderId: receivable.orderId, amountCents: 500_000, creditPaymentId: charge.id },
  });
  // Cobrada en caja.
  const collected = await manualOrder();
  ids.collected = collected.orderId;
  await db.payment.create({ data: { orderId: collected.orderId, method: "cash", status: "approved", amountCents: 500_000, settledAt: new Date() } });
  await db.order.update({ where: { id: collected.orderId }, data: { status: "paid", paidAt: new Date() } });
});

afterAll(async () => {
  try {
    if (tenants.length) await db.restaurant.deleteMany({ where: { id: { in: tenants } } });
  } finally {
    await db.$disconnect();
  }
});

const MANUAL = () => [ids.draft, ids.sent, ids.receivable, ids.collected];

describe("una factura manual nunca es una cuenta abierta del salón", () => {
  it("Mesas: sólo mesas físicas; las manuales vivas sólo cuentan para el acceso", async () => {
    const all = await db.table.findMany({
      where: { restaurantId },
      include: { orders: { where: OPEN_ORDER_STATUS_FILTER, take: 1, select: { id: true } } },
    });
    const floor = floorTablesOf(all, false);
    expect(floor.map((t) => t.id)).toEqual([ids.mesa]);
    expect(floor.flatMap((t) => t.orders.map((o) => o.id))).toEqual([ids.mesaOrder]);
    // Borrador y enviada siguen pendientes (en Facturas manuales).
    expect(pendingManualInvoiceCount(all, false)).toBe(2);
  });

  it("«Mesas en vivo» del datáfono no trae ninguna mesa manual", async () => {
    const live = await db.table.findMany({ where: terminalTablesWhere(restaurantId), select: { id: true, kind: true } });
    expect(live.map((t) => t.id)).toEqual([ids.mesa]);
  });

  it("Resumen: «abiertas ahora» y «falta cobrar» sólo cuentan la mesa", async () => {
    const open = await db.order.findMany({ where: dashboardOpenOrdersWhere(restaurantId), select: { id: true } });
    expect(open.map((o) => o.id)).toEqual([ids.mesaOrder]);
    const uncollected = await loadDashboardUncollected(restaurantId, new Date(0), { kind: "none", pct: 0 });
    expect(uncollected.orderCount).toBe(1);
  });

  it("el cierre de turno no se frena por una factura manual abierta", async () => {
    const open = await listOpenOrders(restaurantId, new Date(0));
    expect(open.map((o) => o.id)).toEqual([ids.mesaOrder]);
    for (const id of MANUAL()) expect(open.map((o) => o.id)).not.toContain(id);
  });

  it("Salón: el que paga por el link no puede pedir efectivo ni datáfono", async () => {
    const req = (body: unknown) =>
      new Request("http://localhost/api/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    for (const orderId of [ids.draft, ids.sent]) {
      const cash = await payCash(req({ orderId, method: "cash", amountCents: 500_000, tipCents: 0 }), { params: Promise.resolve({ slug }) });
      expect(cash.status).toBe(409);
      expect(await cash.json()).toEqual({ error: "online_only" });
      const terminal = await externalTerminal(req({ orderId, amountCents: 500_000, tipCents: 0 }), { params: Promise.resolve({ slug }) });
      expect(terminal.status).toBe(409);
      expect(await terminal.json()).toEqual({ error: "online_only" });
    }
    expect(await db.payment.count({ where: { orderId: { in: [ids.draft, ids.sent] } } })).toBe(0);
    // Una mesa real sí puede pedir efectivo (no se rompió el comensal).
    const table = await payCash(req({ orderId: ids.mesaOrder, method: "cash", amountCents: 300_000, tipCents: 0 }), { params: Promise.resolve({ slug }) });
    expect(table.status).toBe(200);
  });

  it("Facturas manuales: las pendientes (borrador y enviada) siguen a mano", async () => {
    const pending = await db.table.findMany({
      where: { restaurantId, kind: "manual", orders: { some: OPEN_ORDER_STATUS_FILTER } },
      include: { orders: { where: OPEN_ORDER_STATUS_FILTER, select: { id: true } } },
    });
    expect(pending.flatMap((t) => t.orders.map((o) => o.id)).sort()).toEqual([ids.draft, ids.sent].sort());
  });
});
