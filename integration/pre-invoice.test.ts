// Factura ANTES de cobrar, contra PostgreSQL real: emitir sin método de
// pago, la cuenta cerrada a cambios, cobrar después (dividido, con otra
// propina) sin otra factura ni otro número, y las consultas nuevas
// (notas crédito de una factura nunca cobrada, cuentas facturadas en el
// cierre) válidas para Prisma.
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/lib/db";
import { POST as payCash } from "../src/app/api/tenant/[slug]/pay/route";
import { POST as preInvoice } from "../src/app/api/operator/orders/[id]/pre-invoice/route";
import { requireMutableOrderInTx } from "../src/lib/orders";
import { OrderInvoicedError } from "../src/lib/orders/orderInvoicedError";
import { acceptedCreditNoteWhere } from "../src/lib/erp/creditNoteAccounting";
import { listOpenOrders } from "../src/lib/shift";

const scope = vi.hoisted(() => ({ restaurantId: "", userId: "", role: "operator" }));
const print = vi.hoisted(() => ({
  detailed: vi.fn(async () => ({ queued: true, jobs: 1, printerNames: ["Caja"] })),
  safe: vi.fn(async () => undefined),
}));
vi.mock("../src/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("../src/auth", () => ({ auth: async () => ({ user: { id: scope.userId, role: scope.role, restaurantId: scope.restaurantId } }) }));
vi.mock("../src/lib/activeRestaurant", () => ({
  getActiveRestaurantId: async () => scope.restaurantId,
  getActiveContext: async () => ({ restaurantId: scope.restaurantId, session: { user: { id: scope.userId, role: scope.role } } }),
}));
// La base y la factura son reales; lo que sale del sistema queda local.
vi.mock("../src/lib/events", () => ({ publishOrderEvent: vi.fn() }));
vi.mock("../src/lib/auditLog", () => ({ recordAuditEvent: vi.fn(async () => undefined) }));
vi.mock("../src/lib/mailer", () => ({ welcomeIfFirstTime: vi.fn(async () => undefined), sendEmail: vi.fn() }));
vi.mock("../src/lib/invoiceDelivery", () => ({ deliverInvoiceEmail: vi.fn(async () => undefined) }));
vi.mock("../src/lib/print/invoiceQueue", () => ({
  enqueueInvoicePrintSafe: print.safe,
  enqueueInvoicePrintDetailed: print.detailed,
}));
vi.mock("../src/lib/kds/autoFireTickets", () => ({ notifyAutoFiredTickets: vi.fn(async () => undefined) }));
vi.mock("../src/lib/push", () => ({ sendPushToMeserosForTable: vi.fn(async () => undefined) }));
vi.mock("../src/lib/billRequest", () => ({ announceBillRequestedOnPay: vi.fn(async () => undefined) }));

const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["localhost", "127.0.0.1"].includes(database.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname)) {
  throw new Error("Isolated local database required");
}
const tenants: string[] = [];
let slug: string;
let tableId: string;
const request = (body: unknown, key?: string) => new Request("http://localhost/api/test", {
  method: "POST", headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) }, body: JSON.stringify(body),
});
const cash = (orderId: string, amountCents: number, tipCents = 0) => payCash(
  request({ orderId, method: "cash", amountCents, tipCents, settleNow: true }, randomUUID()),
  { params: Promise.resolve({ slug }) },
);
const issue = (orderId: string) => preInvoice(request({}), { params: Promise.resolve({ id: orderId }) });

/** Cuenta servida de $108.000 (INC 8 % dentro del precio). */
async function account() {
  return db.order.create({ data: {
    restaurantId: scope.restaurantId, tableId, shortCode: randomUUID(), status: "served",
    subtotalCents: 10_800_000, totalCents: 10_800_000,
    items: { create: [
      { nameSnapshot: "Ajiaco", priceCentsSnapshot: 3_800_000, qty: 2 },
      { nameSnapshot: "Limonada", priceCentsSnapshot: 3_200_000, qty: 1 },
    ] },
  } });
}

beforeEach(async () => {
  print.detailed.mockClear();
  print.safe.mockClear();
  const tenant = await db.restaurant.create({ data: {
    name: "Factura antes de cobrar", slug: `pre-invoice-${randomUUID()}`,
    salesTaxKind: "inc", salesTaxPct: 8, enabledModules: [], invoicePrefix: "PRE", invoiceNextNumber: 50,
  } });
  tenants.push(tenant.id);
  const user = await db.user.create({ data: { restaurantId: tenant.id, role: "operator", email: `${randomUUID()}@example.test`, passwordHash: "test-only" } });
  const table = await db.table.create({ data: { restaurantId: tenant.id, number: 1, qrToken: randomUUID() } });
  scope.restaurantId = tenant.id; scope.userId = user.id; scope.role = "operator";
  slug = tenant.slug; tableId = table.id;
});
afterAll(async () => {
  try { await db.restaurant.deleteMany({ where: { id: { in: tenants } } }); }
  finally { await db.$disconnect(); }
});

describe("factura antes de cobrar en PostgreSQL", () => {
  it("emite sin método de pago, congela la cuenta y el cobro dividido no emite otra factura", async () => {
    const order = await account();
    const res = await issue(order.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, documentNumber: "PRE50", alreadyIssued: false, einvoicing: false, dian: null, print: { queued: true } });
    expect(print.detailed).toHaveBeenCalledWith(expect.objectContaining({ trigger: "pre_issue", requireReachable: true }));

    const inv = await db.simpleInvoice.findUniqueOrThrow({ where: { orderId: order.id } });
    const items = await db.orderItem.findMany({ where: { orderId: order.id }, select: { id: true } });
    expect(inv).toMatchObject({ invoiceNumber: 50, totalCents: 10_800_000 });
    expect(inv.snapshot).toMatchObject({
      issuedBeforePayment: true,
      totalCents: 10_800_000,
      tipCents: 0,
      salesTaxKind: "inc",
      embeddedTaxCents: 800_000,
    });
    expect([...(inv.snapshot as { orderItemIds: string[] }).orderItemIds].sort()).toEqual(items.map((i) => i.id).sort());
    // Queda constancia de que pidieron la genérica (sin correo).
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).simpleInvoiceEmail).toBe("");

    // Cerrada a cambios: todo cambio de la cuenta pasa por este guard.
    await expect(db.$transaction((tx) => requireMutableOrderInTx(tx, order.id))).rejects.toBeInstanceOf(OrderInvoicedError);

    // Idempotente: pedirla otra vez no numera otra.
    expect(await issue(order.id).then((r) => r.json())).toMatchObject({ ok: true, alreadyIssued: true, invoiceId: inv.id });

    // Cobro dividido: la mitad en efectivo, el resto con otra propina.
    expect(await cash(order.id, 5_400_000, 0).then((r) => r.json())).toMatchObject({ paid: false });
    expect(await cash(order.id, 5_700_000, 300_000).then((r) => r.json())).toMatchObject({ paid: true });
    const paid = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(paid).toMatchObject({ status: "paid", tipCents: 300_000, totalCents: 11_100_000 });
    expect(await db.simpleInvoice.count({ where: { orderId: order.id } })).toBe(1);
    expect((await db.simpleInvoice.findUniqueOrThrow({ where: { orderId: order.id } })).id).toBe(inv.id);
    expect((await db.restaurant.findUniqueOrThrow({ where: { id: scope.restaurantId } })).invoiceNextNumber).toBe(51);
    // Cobrar no saca otra hoja sola.
    expect(print.safe).not.toHaveBeenCalled();
  });

  it("una cuenta facturada sin cobrar aparece en el cierre aunque venga de antes del turno", async () => {
    const order = await account();
    await issue(order.id);
    const later = new Date(Date.now() + 60_000);
    const open = await listOpenOrders(scope.restaurantId, later);
    expect(open).toEqual([expect.objectContaining({ id: order.id, invoiceDocumentNumber: "PRE50" })]);
    // Una cuenta sin factura de antes del turno no entra (como siempre).
    await account();
    expect(await listOpenOrders(scope.restaurantId, later)).toHaveLength(1);
  });

  it("las notas crédito de una factura nunca cobrada quedan fuera de libros (la consulta es válida)", async () => {
    await expect(db.creditNote.findMany({ where: acceptedCreditNoteWhere(scope.restaurantId) })).resolves.toEqual([]);
  });
});
