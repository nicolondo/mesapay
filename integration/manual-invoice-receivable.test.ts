// FACTURA MANUAL EMITIDA POR COBRAR, contra PostgreSQL real:
//   1. «Emitir y enviar factura»: la cuenta sale de Mesas (cerrada a
//      crédito del cliente de la factura, que se crea sin crédito), la
//      factura se emite una vez, aparece en Cartera y el motor asienta la
//      venta contra Clientes (130505).
//   2. Pagar por el link: un abono DIRIGIDO a esa factura (aunque el cliente
//      deba otra más vieja), a la pasarela; sin factura nueva; el motor
//      asienta el recaudo (D 112005 · C 130505) y la venta sigue siendo una.
//   3. Saldarla desde Cartera con otro medio (transferencia).
//   4. Link vencido y reenvío (token nuevo, mismo cargo).
//   5. Anulada con nota crédito: deja de estar por cobrar.
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/lib/db";
import { POST as payLink } from "../src/app/api/operator/orders/[id]/pay-link/route";
import { POST as abonar } from "../src/app/api/operator/billing-customers/[id]/credit-payments/route";
import { settlePaymentLinkInTx } from "../src/lib/paymentLinks";
import { refreshReceivablePayLink } from "../src/lib/manualInvoiceReceivable";
import { loadReceivableDocs } from "../src/lib/erp/reports/carteraQueries";
import { generateJournalForMonth } from "../src/lib/erp/posting";
import { monthRange } from "../src/lib/erp/accounting";
import { listOpenOrders } from "../src/lib/shift";

const scope = vi.hoisted(() => ({ restaurantId: "", userId: "" }));
const mail = vi.hoisted(() => ({ sent: [] as { to: string; subject: string; html: string }[] }));
vi.mock("../src/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("../src/auth", () => ({ auth: async () => ({ user: { id: scope.userId, role: "operator", restaurantId: scope.restaurantId } }) }));
vi.mock("../src/lib/operatorScope", () => ({
  requireOperatorScope: async () => ({ restaurantId: scope.restaurantId, role: "operator", userId: scope.userId }),
  isScopeError: (v: { error?: string }) => "error" in v,
}));
vi.mock("../src/lib/activeRestaurant", () => ({
  getActiveRestaurantId: async () => scope.restaurantId,
  getActiveContext: async () => ({ restaurantId: scope.restaurantId, session: { user: { id: scope.userId, role: "operator" } } }),
}));
// La base, la factura y el motor son reales; lo que sale del sistema queda local.
vi.mock("../src/lib/events", () => ({ publishOrderEvent: vi.fn() }));
vi.mock("../src/lib/auditLog", () => ({ recordAuditEvent: vi.fn(async () => undefined) }));
vi.mock("../src/lib/mailer", () => ({
  welcomeIfFirstTime: vi.fn(async () => undefined),
  sendEmail: vi.fn(async (args: { to: string; subject: string; html: string }) => {
    mail.sent.push(args);
    return true;
  }),
}));
vi.mock("../src/lib/invoiceDelivery", () => ({ deliverInvoiceEmail: vi.fn(async () => undefined) }));
vi.mock("../src/lib/print/invoiceQueue", () => ({
  enqueueInvoicePrintSafe: vi.fn(async () => undefined),
  enqueueInvoicePrintDetailed: vi.fn(async () => ({ queued: false, jobs: 0, printerNames: [] })),
}));
vi.mock("../src/lib/kds/autoFireTickets", () => ({ notifyAutoFiredTickets: vi.fn(async () => undefined) }));

const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["localhost", "127.0.0.1"].includes(database.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname)) {
  throw new Error("Isolated local database required");
}

const tenants: string[] = [];
const request = (body: unknown) =>
  new Request("http://localhost:3572/api/test", {
    method: "POST",
    headers: { "content-type": "application/json", host: "localhost:3572" },
    body: JSON.stringify(body),
  });
const send = (orderId: string, body: unknown) => payLink(request(body), { params: Promise.resolve({ id: orderId }) });

/** Mes contable de hoy (Bogotá), para correr el motor sobre lo que se acaba de cobrar. */
function currentMonth(): string {
  const bogota = new Date(Date.now() - 5 * 3_600_000);
  return `${bogota.getUTCFullYear()}-${String(bogota.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function engineLines(restaurantId: string, month: string) {
  await generateJournalForMonth(restaurantId, month, monthRange(month)!);
  const entries = await db.journalEntry.findMany({
    where: { restaurantId, sourceRef: month },
    include: { lines: true },
  });
  const bySource = (source: string) =>
    entries
      .filter((e) => e.source === source)
      .flatMap((e) => e.lines)
      .reduce((acc, l) => {
        acc[l.accountCode] = (acc[l.accountCode] ?? 0) + Number(l.debitCents) - Number(l.creditCents);
        return acc;
      }, {} as Record<string, number>);
  return { sale: bySource("sale"), abonos: bySource("customer_credit_payment"), entries };
}

let manualTableId: string;

/** Factura manual abierta de $108.000 (INC 8 % dentro) a nombre de un cliente. */
async function manualInvoice(doc = "900123456") {
  const order = await db.order.create({
    data: {
      restaurantId: scope.restaurantId,
      tableId: manualTableId,
      shortCode: randomUUID(),
      status: "open",
      subtotalCents: 10_800_000,
      totalCents: 10_800_000,
      locale: "es",
      items: { create: [{ nameSnapshot: "Catering evento", priceCentsSnapshot: 10_800_000, qty: 1, servedAt: new Date() }] },
    },
  });
  await db.invoiceRequest.create({
    data: {
      restaurantId: scope.restaurantId,
      orderId: order.id,
      customerName: "Empresa Demo S.A.S.",
      docType: "NIT",
      docNumber: doc,
      email: "pagos@empresa-demo.test",
    },
  });
  return order;
}

beforeEach(async () => {
  mail.sent = [];
  const tenant = await db.restaurant.create({
    data: {
      name: "Factura por cobrar",
      slug: `receivable-${randomUUID()}`,
      salesTaxKind: "inc",
      salesTaxPct: 8,
      enabledModules: ["accounting"],
      invoicePrefix: "FM",
      invoiceNextNumber: 10,
      kushkiMerchantId: "mock-merchant",
      kushkiOnboardingStatus: "active",
      enabledPaymentMethods: ["kushki_card", "kushki_pse", "kushki_apple_pay", "cash", "external_terminal"],
    },
  });
  tenants.push(tenant.id);
  const user = await db.user.create({
    data: { restaurantId: tenant.id, role: "operator", email: `${randomUUID()}@example.test`, passwordHash: "test-only" },
  });
  const table = await db.table.create({
    data: { restaurantId: tenant.id, number: -100, kind: "manual", label: "Factura manual", qrToken: randomUUID(), reservable: false },
  });
  scope.restaurantId = tenant.id;
  scope.userId = user.id;
  manualTableId = table.id;
});

afterAll(async () => {
  try {
    if (tenants.length) {
      await db.journalEntry.deleteMany({ where: { restaurantId: { in: tenants } } });
      await db.restaurant.deleteMany({ where: { id: { in: tenants } } });
    }
  } finally {
    await db.$disconnect();
  }
});

describe("factura manual emitida por cobrar", () => {
  it("emitir y enviar: sale de Mesas, una factura, en Cartera y la venta contra Clientes", async () => {
    const order = await manualInvoice();
    const res = await send(order.id, { issue: true, emails: ["pagos@empresa-demo.test", "contabilidad@empresa-demo.test"] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ issued: true, receivable: { amountCents: 10_800_000 } });
    expect(body.sentTo).toEqual(["pagos@empresa-demo.test", "contabilidad@empresa-demo.test"]);

    // Fuera de Mesas / Salón / datáfono: ya no es una cuenta abierta.
    const closed = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(closed.status).toBe("paid");
    expect((await listOpenOrders(scope.restaurantId, new Date(0))).map((o) => o.id)).not.toContain(order.id);

    // A crédito del cliente de la factura, creado SIN crédito.
    const charge = await db.payment.findFirstOrThrow({ where: { orderId: order.id } });
    expect(charge).toMatchObject({ method: "customer_credit", status: "approved", amountCents: 10_800_000, tipCents: 0 });
    const customer = await db.billingCustomer.findUniqueOrThrow({ where: { id: charge.billingCustomerId! } });
    expect(customer).toMatchObject({ docType: "NIT", docNumber: "900123456", verificationDigit: "8", creditEnabled: false, customerName: "Empresa Demo S.A.S." });

    // Una sola factura, a su nombre.
    const invoices = await db.simpleInvoice.findMany({ where: { orderId: order.id } });
    expect(invoices).toHaveLength(1);
    expect(invoices[0].invoiceNumber).toBe(10);

    // El link pasó a cobrar ese cargo; los dos correos salieron con la factura.
    const link = await db.paymentLink.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(link).toMatchObject({ kind: "order", status: "pending", creditPaymentId: charge.id, amountCents: 10_800_000 });
    expect(link.emailRecipients).toEqual(["pagos@empresa-demo.test", "contabilidad@empresa-demo.test"]);
    expect(mail.sent.map((m) => m.to)).toEqual(["pagos@empresa-demo.test", "contabilidad@empresa-demo.test"]);
    expect(mail.sent[0].subject).toContain("factura FM10");
    expect(mail.sent[0].html).toContain(`/r/${(await db.restaurant.findUniqueOrThrow({ where: { id: scope.restaurantId } })).slug}/cuenta/${link.token}`);

    // Cartera: por cobrar.
    const today = new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);
    const cartera = await loadReceivableDocs(scope.restaurantId, today);
    expect(cartera.docs).toEqual([expect.objectContaining({ id: charge.id, source: "customer_credit", totalCents: 10_800_000, outstandingCents: 10_800_000 })]);

    // Motor: venta del día D 130505 Clientes · C ingresos + INC (una vez).
    const { sale, abonos } = await engineLines(scope.restaurantId, currentMonth());
    expect(sale).toEqual({ "130505": 10_800_000, "413505": -10_000_000, "241205": -800_000 });
    expect(abonos).toEqual({});
  });

  it("pagar por el link: abono dirigido a ESA factura (aunque deba otra más vieja), sin factura nueva, recaudo a la pasarela", async () => {
    // Deuda más vieja del mismo cliente.
    const older = await manualInvoice();
    await send(older.id, { issue: true, emails: [] });
    const olderCharge = await db.payment.findFirstOrThrow({ where: { orderId: older.id } });
    await db.payment.update({ where: { id: olderCharge.id }, data: { settledAt: new Date(Date.now() - 10 * 86_400_000) } });

    const order = await manualInvoice();
    await send(order.id, { issue: true, emails: ["pagos@empresa-demo.test"] });
    const charge = await db.payment.findFirstOrThrow({ where: { orderId: order.id } });
    expect(charge.billingCustomerId).toBe(olderCharge.billingCustomerId);
    const link = await db.paymentLink.findUniqueOrThrow({ where: { orderId: order.id } });

    // Kushki aprobó (tarjeta): el riel de siempre cierra el link.
    const settled = await db.$transaction((tx) =>
      settlePaymentLinkInTx(tx, { id: link.id }, { approved: true, providerRef: "tx-mock-1", method: "kushki_card" }),
    );
    expect(settled.status).toBe("paid");
    // El webhook que llega después no deja otro abono.
    await db.$transaction((tx) => settlePaymentLinkInTx(tx, { providerRef: "tx-mock-1" }, { approved: true, providerRef: "tx-mock-1" }));

    const abonos = await db.customerCreditPayment.findMany({ where: { billingCustomerId: charge.billingCustomerId! } });
    expect(abonos).toHaveLength(1);
    expect(abonos[0]).toMatchObject({ amountCents: 10_800_000, accountCode: "112005", creditChargeId: charge.id, paymentLinkId: link.id });
    expect(await db.simpleInvoice.count({ where: { orderId: order.id } })).toBe(1);
    expect(await db.payment.count({ where: { orderId: order.id } })).toBe(1);

    const fresh = await refreshReceivablePayLink(await db.paymentLink.findUniqueOrThrow({ where: { id: link.id } }));
    expect(fresh.state).toBe("paid");

    // Cartera: la factura pagada sale; la vieja sigue entera.
    const today = new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);
    const cartera = await loadReceivableDocs(scope.restaurantId, today);
    expect(cartera.docs.map((d) => [d.id, d.outstandingCents])).toEqual([[olderCharge.id, 10_800_000]]);

    // Motor: dos ventas (las dos facturas) y un recaudo; el impuesto, una vez por factura.
    const { sale, abonos: recaudo } = await engineLines(scope.restaurantId, currentMonth());
    expect(sale).toEqual({ "130505": 21_600_000, "413505": -20_000_000, "241205": -1_600_000 });
    expect(recaudo).toEqual({ "112005": 10_800_000, "130505": -10_800_000 });
  });

  it("saldarla desde Cartera con otro medio (transferencia) la deja pagada", async () => {
    const order = await manualInvoice();
    await send(order.id, { issue: true, emails: [] });
    const charge = await db.payment.findFirstOrThrow({ where: { orderId: order.id } });
    const res = await abonar(
      request({ amountCents: 10_800_000, accountCode: "111005", creditChargeId: charge.id, note: "Transferencia" }),
      { params: Promise.resolve({ id: charge.billingCustomerId! }) },
    );
    expect(res.status).toBe(201);
    const link = await db.paymentLink.findUniqueOrThrow({ where: { orderId: order.id } });
    expect((await refreshReceivablePayLink(link)).state).toBe("paid");
    // Ya no hay nada que reenviar.
    const again = await send(order.id, { emails: ["pagos@empresa-demo.test"] });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "receivable_closed", state: "paid" });
  });

  it("link vencido: reenviarlo lo renueva (token nuevo) y sigue cobrando el saldo vivo", async () => {
    const order = await manualInvoice();
    await send(order.id, { issue: true, emails: [] });
    const charge = await db.payment.findFirstOrThrow({ where: { orderId: order.id } });
    // Un abono parcial desde Cartera y el link vencido.
    await abonar(request({ amountCents: 800_000, accountCode: "110505", creditChargeId: charge.id }), {
      params: Promise.resolve({ id: charge.billingCustomerId! }),
    });
    const before = await db.paymentLink.update({
      where: { orderId: order.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await refreshReceivablePayLink(before)).state).toBe("expired");

    const res = await send(order.id, { emails: ["pagos@empresa-demo.test"] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rotated).toBe(true);
    const after = await db.paymentLink.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(after.token).not.toBe(before.token);
    expect(after).toMatchObject({ creditPaymentId: charge.id, amountCents: 10_000_000, status: "pending" });
    expect(after.expiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect((await refreshReceivablePayLink(after)).state).toBe("open");
  });

  it("anulada con nota crédito: deja de estar por cobrar y el link no cobra", async () => {
    const order = await manualInvoice();
    await send(order.id, { issue: true, emails: [] });
    const charge = await db.payment.findFirstOrThrow({ where: { orderId: order.id } });
    // Lo que fija la contabilización de una nota crédito aceptada que anula
    // la factura entera (erp/creditNoteAccounting.stampCreditNoteAccounting).
    await db.payment.update({ where: { id: charge.id }, data: { creditNoteCents: 10_800_000 } });
    const link = await db.paymentLink.findUniqueOrThrow({ where: { orderId: order.id } });
    expect((await refreshReceivablePayLink(link)).state).toBe("cancelled");
    const today = new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);
    expect((await loadReceivableDocs(scope.restaurantId, today)).docs).toEqual([]);
  });

  it("sin cliente identificado no se emite ni sale de Mesas", async () => {
    const order = await manualInvoice();
    await db.invoiceRequest.deleteMany({ where: { orderId: order.id } });
    const res = await send(order.id, { issue: true, emails: ["a@empresa-demo.test"] });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "customer_required" });
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("open");
    expect(await db.simpleInvoice.count({ where: { orderId: order.id } })).toBe(0);
  });
});
