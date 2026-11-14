// El TOTAL A PAGAR de la factura, medio de pago por medio de pago, contra
// PostgreSQL real.
//
// El dueño: «revisar que todas las facturas, sin importar el medio de pago,
// tengan el valor total incluyendo la propina». Cada familia de medio cobra
// por su propio camino (ruta del cobro, webhook de Kushki, Bre-B, crédito,
// bonos), pero todos terminan en `recomputeOrderTotalsInTx` (Order.tipCents =
// Σ propinas de los pagos aprobados) y en `issueInvoiceOnPaid`. Lo que se
// verifica en cada uno, con la factura YA emitida:
//
//   · «Total factura» = la venta (subtotal + impuesto encima − descuento):
//     lo que declara el XML, sin propina;
//   · «Propina voluntaria» = la propina que de verdad se cobró (Σ pagos);
//   · «TOTAL A PAGAR» = factura + propina = Σ de lo cobrado, y es el renglón
//     destacado de la tirilla que imprime el agente.
//
// Kushki NO se llama: el proveedor de cobro y el gateway de Bre-B son dobles
// (como en bre-b.test.ts) y los datáfonos/PSE se aprueban por el mismo motor
// del webhook (`processKushkiWebhook`).
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Llave maestra de PRUEBA (cifra las llaves Bre-B del comercio de prueba),
// como en bre-b.test.ts: en CI la variable no existe.
vi.hoisted(() => {
  process.env.MESAPAY_SECRET_KEY ??= "ab".repeat(32);
});
import { db } from "../src/lib/db";
import { encrypt } from "../src/lib/crypto";
import { formatMoney } from "../src/lib/format";
import { invoicePayableOf, type InvoiceSnapshot } from "../src/lib/invoice";
import { reservePayment } from "../src/lib/payments/intent";
import { processKushkiWebhook } from "../src/lib/payments/webhookHandler";
import { redeemVoucher } from "../src/lib/vouchers/redeem";
import { buildInvoiceDocument } from "../src/lib/print/invoiceQueue";
import { POST as pay } from "../src/app/api/tenant/[slug]/pay/route";
import { POST as settleCash } from "../src/app/api/operator/payments/[id]/settle-cash/route";
import { POST as requestExternalTerminal } from "../src/app/api/tenant/[slug]/pay/external-terminal-request/route";
import { POST as settleExternalTerminal } from "../src/app/api/operator/payments/[id]/settle-external-terminal/route";
import { POST as requestKushkiTerminal } from "../src/app/api/tenant/[slug]/pay/terminal-request/route";
import { POST as kushkiCharge } from "../src/app/api/tenant/[slug]/pay/kushki-charge/route";
import { POST as startBreB } from "../src/app/api/tenant/[slug]/pay/bre-b/route";
import { POST as kushkiWebhook } from "../src/app/api/webhooks/kushki/route";
import { POST as settleCredit } from "../src/app/api/operator/orders/[id]/settle-credit/route";
import { POST as preInvoice } from "../src/app/api/operator/orders/[id]/pre-invoice/route";

const scope = vi.hoisted(() => ({ restaurantId: "", userId: "", role: "operator", loggedIn: true }));
vi.mock("../src/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("../src/auth", () => ({
  auth: async () =>
    scope.loggedIn
      ? { user: { id: scope.userId, role: scope.role, email: "staff@example.test", restaurantId: scope.restaurantId } }
      : null,
}));
vi.mock("../src/lib/activeRestaurant", () => ({
  getActiveRestaurantId: async () => scope.restaurantId,
  getActiveContext: async () =>
    scope.loggedIn ? { restaurantId: scope.restaurantId, session: { user: { id: scope.userId, role: scope.role } } } : null,
}));
// La base, el cobro y la factura son reales; lo que sale del sistema queda local.
vi.mock("../src/lib/events", () => ({ publishOrderEvent: vi.fn() }));
vi.mock("../src/lib/auditLog", () => ({ recordAuditEvent: vi.fn(async () => undefined) }));
vi.mock("../src/lib/mailer", () => ({ welcomeIfFirstTime: vi.fn(async () => undefined), sendEmail: vi.fn() }));
vi.mock("../src/lib/invoiceDelivery", () => ({ deliverInvoiceEmail: vi.fn(async () => undefined) }));
vi.mock("../src/lib/print/invoiceQueue", async (importOriginal) => ({
  // `buildInvoiceDocument` es el REAL: arma la tirilla que imprime el agente.
  ...(await importOriginal<typeof import("../src/lib/print/invoiceQueue")>()),
  enqueueInvoicePrintSafe: vi.fn(async () => undefined),
  enqueueInvoicePrintDetailed: vi.fn(async () => ({ queued: true, jobs: 1, printerNames: ["Caja"] })),
}));
vi.mock("../src/lib/kds/autoFireTickets", () => ({ notifyAutoFiredTickets: vi.fn(async () => undefined) }));
vi.mock("../src/lib/push", () => ({ sendPushToMeserosForTable: vi.fn(async () => undefined) }));
vi.mock("../src/lib/billRequest", () => ({ announceBillRequestedOnPay: vi.fn(async () => undefined) }));
// Tarjeta en línea / Apple Pay: el cobro a Kushki es un doble que aprueba.
vi.mock("../src/lib/payments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/payments")>()),
  getPaymentProvider: async () => ({
    chargeWithToken: async () => ({ status: "approved", providerRef: `fake-${randomUUID()}`, raw: {} }),
  }),
  getRestaurantPrivateKey: async () => "private-key-test-fake",
}));
vi.mock("../src/lib/walletTrackingCapture", () => ({ capturePaymentTrackingFields: async () => ({}) }));
// Bre-B: el gateway de Kushki es un doble con la forma del contrato.
vi.mock("../src/lib/payments/breB/gateway", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/lib/payments/breB/gateway")>();
  const fake = {
    processor: async () => ({ name: "Bre-B Test Processor", channel: "QR" }),
    forgetProcessor: () => {},
    requestToken: async () => ({ token: `tok-${randomUUID()}` }),
    init: async () => ({
      qrImage: "data:image/png;base64,AA==",
      transactionReference: `ref-${randomUUID()}`,
      ticketNumber: `${Date.now()}`,
    }),
    status: async (token: string) => ({ status: "pending" as const, amountCents: null, currency: null, token, transactionReference: null, ticketNumber: null }),
    cancel: async () => {},
  };
  return { ...orig, breBGatewayFor: () => fake };
});

const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["localhost", "127.0.0.1"].includes(database.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname)) {
  throw new Error("Isolated local database required");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = Record<string, any>;

/** $ 120.000 de consumo con impoconsumo 8 % incluido y $ 12.000 de propina. */
const SALE = 12_000_000;
const TIP = 1_200_000;

const tenants: string[] = [];
let slug = "";
let tableId = "";

const json = (body: unknown, key: string = randomUUID()) =>
  new Request("http://localhost/api/test", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(body),
  });
const tenantParams = () => ({ params: Promise.resolve({ slug }) });
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });
const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Body });

/** Cuenta servida, con la factura (genérica, sin correo) pedida en el cobro. */
async function account(subtotalCents = SALE) {
  return db.order.create({
    data: {
      restaurantId: scope.restaurantId, tableId, shortCode: randomUUID(), status: "served",
      subtotalCents, totalCents: subtotalCents, simpleInvoiceEmail: "",
      items: { create: [{ nameSnapshot: "Plato de prueba", priceCentsSnapshot: subtotalCents, qty: 1 }] },
    },
  });
}

/**
 * Lo que muestra la factura emitida: los tres renglones finales
 * (`invoicePayableOf`, los mismos de la vista web, los correos y el
 * datáfono) y la tirilla del agente, armada con la orden de HOY.
 */
async function shown(orderId: string) {
  const inv = await db.simpleInvoice.findUniqueOrThrow({
    where: { orderId },
    include: { order: { select: { tipCents: true, subtotalCents: true, taxCents: true, discountCents: true, status: true } } },
  });
  const payments = await db.payment.findMany({
    where: { orderId, status: "approved" },
    orderBy: { createdAt: "asc" },
    select: { method: true, amountCents: true, tipCents: true },
  });
  const snapshot = inv.snapshot as unknown as InvoiceSnapshot;
  const payable = invoicePayableOf(snapshot, inv.order);
  const paper = await buildInvoiceDocument({
    snapshot, invoiceNumber: inv.invoiceNumber, paperWidthMm: 80, currency: "COP",
    payments, locale: "es", order: inv.order,
  });
  return { inv, snapshot, payable, paper, payments, order: inv.order };
}

const money = (cents: number) => formatMoney(cents, { currency: "COP", locale: "es" });

/**
 * La regla, para cualquier medio: la factura es la venta; la propina es la
 * cobrada; el TOTAL A PAGAR (destacado en la tirilla) es la suma de las dos
 * y es exactamente lo que entró en los pagos.
 */
async function expectTotalToPay(orderId: string, expected: { sale: number; tip: number }) {
  const { payable, paper, payments, order } = await shown(orderId);
  const collected = payments.reduce((sum, p) => sum + p.amountCents, 0);
  const collectedTip = payments.reduce((sum, p) => sum + p.tipCents, 0);
  expect(order.status).toBe("paid");
  expect(collectedTip).toBe(expected.tip);
  expect(order.tipCents).toBe(expected.tip);
  expect(payable).toEqual({
    invoiceTotalCents: expected.sale,
    tipCents: expected.tip,
    totalToPayCents: expected.sale + expected.tip,
  });
  // La factura es la venta: lo que declara el XML (sin propina).
  expect(payable.invoiceTotalCents).toBe(order.subtotalCents + order.taxCents - order.discountCents);
  expect(payable.totalToPayCents).toBe(collected);
  // La tirilla: «Total …», «Propina voluntaria» (si hay) y el TOTAL A PAGAR
  // destacado, último y único.
  const strong = paper.totals.filter((r) => r.strong);
  expect(strong).toEqual([{ label: "TOTAL A PAGAR", amount: money(expected.sale + expected.tip), strong: true }]);
  expect(paper.totals.at(-1)).toEqual(strong[0]);
  const tipRow = paper.totals.find((r) => r.label === "Propina voluntaria");
  expect(tipRow?.amount ?? null).toBe(expected.tip > 0 ? money(expected.tip) : null);
  // La forma de pago suma el TOTAL A PAGAR (cada pago con su propina adentro).
  expect(paper.paymentRows.length).toBeGreaterThan(0);
  return { payable, paper };
}

beforeEach(async () => {
  const tenant = await db.restaurant.create({
    data: {
      name: "Restaurante de prueba", slug: `total-a-pagar-${randomUUID()}`, country: "CO",
      salesTaxKind: "inc", salesTaxPct: 8, enabledModules: ["vouchers"],
      kushkiMode: "mock", kushkiMerchantId: `merchant-${randomUUID()}`,
      enabledPaymentMethods: ["cash", "external_terminal", "kushki_card_terminal", "kushki_card", "kushki_apple_pay", "kushki_pse", "kushki_bre_b"],
      kushkiBreBPublicKey: "pub-breb-test-fake",
      kushkiBreBPrivateKeyEnc: encrypt("priv-breb-test-fake"),
      invoicePrefix: "PRU", invoiceNextNumber: 1,
    },
  });
  tenants.push(tenant.id);
  const user = await db.user.create({ data: { restaurantId: tenant.id, role: "operator", email: `${randomUUID()}@example.test`, passwordHash: "test-only" } });
  const table = await db.table.create({ data: { restaurantId: tenant.id, number: 1, qrToken: randomUUID() } });
  await db.terminalDevice.create({ data: { restaurantId: tenant.id, kushkiDeviceId: `device-${randomUUID()}`, label: "Datáfono de prueba" } });
  Object.assign(scope, { restaurantId: tenant.id, userId: user.id, role: "operator", loggedIn: true });
  slug = tenant.slug;
  tableId = table.id;
});
afterAll(async () => {
  try {
    await db.kushkiWebhookEvent.deleteMany({ where: { restaurantId: { in: tenants } } });
    await db.restaurant.deleteMany({ where: { id: { in: tenants } } });
  } finally {
    await db.$disconnect();
  }
});

describe("TOTAL A PAGAR = total factura + propina cobrada, por familia de medio de pago (factura emitida al cobrar)", () => {
  it("efectivo cobrado por el staff", async () => {
    const order = await account();
    const res = await read(await pay(json({ orderId: order.id, method: "cash", amountCents: SALE + TIP, tipCents: TIP, settleNow: true }), tenantParams()));
    expect(res.body).toMatchObject({ paid: true });
    const { paper } = await expectTotalToPay(order.id, { sale: SALE, tip: TIP });
    expect(paper.paymentRows).toEqual([{ label: "Efectivo", amount: money(SALE + TIP) }]);
  });

  it("efectivo pedido por el comensal y confirmado con «quédese con el cambio» (la vuelta es propina)", async () => {
    const order = await account();
    scope.loggedIn = false;
    const requested = await read(await pay(json({ orderId: order.id, method: "cash", amountCents: SALE, tipCents: 0 }), tenantParams()));
    scope.loggedIn = true;
    // Pagó con $ 132.000 y no quiso vuelta: $ 12.000 de propina.
    const settled = await read(await settleCash(json({ cashReceivedCents: SALE + TIP, changeGivenCents: 0 }), idParams(requested.body.paymentId)));
    expect(settled.status).toBe(200);
    await expectTotalToPay(order.id, { sale: SALE, tip: TIP });
  });

  it("datáfono del comercio", async () => {
    const order = await account();
    const requested = await read(await requestExternalTerminal(json({ orderId: order.id, amountCents: SALE + TIP, tipCents: TIP }), tenantParams()));
    const settled = await read(await settleExternalTerminal(json({ action: "approve" }), idParams(requested.body.paymentId)));
    expect(settled.body).toMatchObject({ paid: true, status: "approved" });
    const { paper } = await expectTotalToPay(order.id, { sale: SALE, tip: TIP });
    expect(paper.paymentRows).toEqual([{ label: "Tarjeta · datáfono del comercio", amount: money(SALE + TIP) }]);
  });

  it("datáfono Kushki (Smart POS): la solicitud lleva la propina y la aprueba el callback", async () => {
    const order = await account();
    const requested = await read(await requestKushkiTerminal(json({ orderId: order.id, amountCents: SALE + TIP, tipCents: TIP }), tenantParams()));
    expect(requested.status).toBe(200);
    const result = await processKushkiWebhook({
      eventId: randomUUID(), type: "terminal.approved", restaurantId: scope.restaurantId,
      paymentId: requested.body.paymentId, orderId: order.id, providerRef: `terminal-${randomUUID()}`, amountCents: SALE + TIP,
    });
    expect(result.status).toBe("ok");
    const { paper } = await expectTotalToPay(order.id, { sale: SALE, tip: TIP });
    expect(paper.paymentRows).toEqual([{ label: "Tarjeta · datáfono", amount: money(SALE + TIP) }]);
  });

  it.each([
    ["kushki_card", "Tarjeta"],
    ["kushki_apple_pay", "Billetera digital"],
  ] as const)("pago en línea (%s) por la ruta del cobro", async (method, label) => {
    const order = await account();
    scope.loggedIn = false;
    const res = await read(await kushkiCharge(json({ orderId: order.id, method, token: `token-${randomUUID()}`, amountCents: SALE + TIP, tipCents: TIP }), tenantParams()));
    expect(res.body).toMatchObject({ approved: true, paid: true });
    const { paper } = await expectTotalToPay(order.id, { sale: SALE, tip: TIP });
    expect(paper.paymentRows).toEqual([{ label, amount: money(SALE + TIP) }]);
  });

  it.each([
    ["kushki_google_pay", "charge.approved", "Billetera digital"],
    ["kushki_pse", "pse.approved", "PSE · transferencia"],
  ] as const)("%s: el pago reservado con su propina y aprobado por el webhook", async (method, type, label) => {
    const order = await account();
    const { payment } = await reservePayment({ orderId: order.id, method, status: "pending", amountCents: SALE + TIP, tipCents: TIP }, randomUUID());
    const result = await processKushkiWebhook({
      eventId: randomUUID(), type, restaurantId: scope.restaurantId, paymentId: payment.id,
      orderId: order.id, providerRef: `provider-${randomUUID()}`, amountCents: SALE + TIP,
    });
    expect(result.status).toBe("ok");
    const { paper } = await expectTotalToPay(order.id, { sale: SALE, tip: TIP });
    expect(paper.paymentRows).toEqual([{ label, amount: money(SALE + TIP) }]);
  });

  it("Bre-B: el QR cobra venta + propina y el aviso de Kushki salda la cuenta", async () => {
    const order = await account();
    scope.loggedIn = false;
    const started = await read(await startBreB(json({ orderId: order.id, amountCents: SALE + TIP, tipCents: TIP }), tenantParams()));
    expect(started.status).toBe(200);
    const charge = await db.breBCharge.findUniqueOrThrow({ where: { paymentId: started.body.paymentId } });
    const res = await read(await kushkiWebhook(json({
      token: charge.token, status: "approvedTransaction",
      ticketNumber: charge.ticketNumber, transactionReference: charge.transactionReference,
      amount: { subtotalIva: 0, subtotalIva0: charge.amountCents / 100, iva: 0 },
      metadata: { breBChargeId: charge.id, paymentId: charge.paymentId },
    })));
    expect(res.body.status).toBe("approved");
    const { paper } = await expectTotalToPay(order.id, { sale: SALE, tip: TIP });
    expect(paper.paymentRows).toEqual([{ label: "Bre-B · transferencia", amount: money(SALE + TIP) }]);
  });

  it("a crédito de un cliente de facturación, con la propina anotada", async () => {
    const order = await account();
    const customer = await db.billingCustomer.create({ data: {
      restaurantId: scope.restaurantId, customerName: "Cliente de prueba S.A.S.", docType: "NIT",
      docNumber: `9${Date.now()}`.slice(0, 10), email: "cliente@example.test", creditEnabled: true,
    } });
    const res = await read(await settleCredit(json({ billingCustomerId: customer.id, tipCents: TIP }), idParams(order.id)));
    expect(res.body).toMatchObject({ ok: true, paid: true });
    const { paper } = await expectTotalToPay(order.id, { sale: SALE, tip: TIP });
    expect(paper.paymentRows).toEqual([{ label: "Crédito", amount: money(SALE + TIP) }]);
  });

  async function voucher(valueCents: number) {
    const customer = await db.billingCustomer.create({ data: {
      restaurantId: scope.restaurantId, customerName: "Empresa de prueba S.A.S.", docType: "NIT",
      docNumber: `8${Date.now()}${Math.floor(Math.random() * 100)}`.slice(0, 11), email: "empresa@example.test",
    } });
    const batch = await db.voucherBatch.create({ data: {
      restaurantId: scope.restaurantId, billingCustomerId: customer.id, mode: "credit",
      unitValueCents: valueCents, quantity: 1,
    } });
    const code = `PR${randomUUID().replace(/[^A-HJ-NP-Z2-9]/gi, "").toUpperCase().replace(/[IO01]/g, "X").slice(0, 8).padEnd(8, "K")}`;
    await db.voucher.create({ data: { restaurantId: scope.restaurantId, batchId: batch.id, code, valueCents, balanceCents: valueCents } });
    return code;
  }

  it("bono que cubre toda la cuenta: sin propina, TOTAL A PAGAR = total factura", async () => {
    const order = await account();
    const r = await redeemVoucher({ restaurantId: scope.restaurantId, code: await voucher(SALE), orderId: order.id, channel: "staff", userId: scope.userId });
    expect(r).toMatchObject({ ok: true, fullyPaid: true });
    const { paper } = await expectTotalToPay(order.id, { sale: SALE, tip: 0 });
    expect(paper.paymentRows).toEqual([{ label: "Bono empresarial", amount: money(SALE) }]);
  });

  it("pago mixto: bono por una parte y el resto en efectivo con la propina", async () => {
    const order = await account();
    const r = await redeemVoucher({ restaurantId: scope.restaurantId, code: await voucher(5_000_000), orderId: order.id, channel: "staff", userId: scope.userId });
    expect(r).toMatchObject({ ok: true, fullyPaid: false });
    await pay(json({ orderId: order.id, method: "cash", amountCents: SALE - 5_000_000 + TIP, tipCents: TIP, settleNow: true }), tenantParams());
    const { paper } = await expectTotalToPay(order.id, { sale: SALE, tip: TIP });
    expect(paper.paymentRows).toEqual([
      { label: "Bono empresarial", amount: money(5_000_000) },
      { label: "Efectivo", amount: money(SALE - 5_000_000 + TIP) },
    ]);
  });

  it("pago mixto: efectivo y datáfono del comercio, cada uno con su parte de la propina", async () => {
    const order = await account();
    await pay(json({ orderId: order.id, method: "cash", amountCents: 4_400_000, tipCents: 400_000, settleNow: true }), tenantParams());
    const requested = await read(await requestExternalTerminal(json({ orderId: order.id, amountCents: 8_800_000, tipCents: 800_000 }), tenantParams()));
    await settleExternalTerminal(json({ action: "approve" }), idParams(requested.body.paymentId));
    await expectTotalToPay(order.id, { sale: SALE, tip: TIP });
  });

  it("cuenta dividida en partes iguales: tres pagos, propinas distintas, una sola factura", async () => {
    const order = await account();
    const part = SALE / 3;
    for (const tip of [400_000, 0, 600_000]) {
      await pay(json({ orderId: order.id, method: "cash", amountCents: part + tip, tipCents: tip, settleNow: true }), tenantParams());
    }
    expect(await db.simpleInvoice.count({ where: { orderId: order.id } })).toBe(1);
    await expectTotalToPay(order.id, { sale: SALE, tip: 1_000_000 });
  });

  it("sin propina: el TOTAL A PAGAR es el total de la factura y no hay renglón de propina", async () => {
    const order = await account();
    await pay(json({ orderId: order.id, method: "cash", amountCents: SALE, tipCents: 0, settleNow: true }), tenantParams());
    const { paper } = await expectTotalToPay(order.id, { sale: SALE, tip: 0 });
    expect(paper.totals.map((r) => r.label).slice(-2)).toEqual(["Total comprobante", "TOTAL A PAGAR"]);
  });
});

describe("factura emitida ANTES de cobrar (#577): la propina es la REAL de la orden", () => {
  const issue = (orderId: string, body: Record<string, unknown> = {}) => preInvoice(json(body), idParams(orderId));

  it("emitida con «Sin propina» en el cobro: queda guardado y ninguna hoja sugiere propina", async () => {
    const order = await account();
    expect((await issue(order.id, { suggestedTipPct: 0 })).status).toBe(200);
    const { snapshot, payable, paper } = await shown(order.id);
    expect(snapshot).toMatchObject({ issuedBeforePayment: true, suggestedTipPct: 0, tipCents: 0 });
    expect(payable.totalToPayCents).toBe(SALE);
    expect(paper.tipRows ?? []).toEqual([]);
    expect(paper.totals.map((r) => r.label)).not.toContain("Propina voluntaria");
    // Y si el cliente igual deja propina al pagar, sale como propina real.
    await pay(json({ orderId: order.id, method: "cash", amountCents: SALE + 500_000, tipCents: 500_000, settleNow: true }), tenantParams());
    await expectTotalToPay(order.id, { sale: SALE, tip: 500_000 });
    expect((await shown(order.id)).paper.tipRows ?? []).toEqual([]);
  });

  it("emitida con propina elegida (15 %): la sugerida es ésa, aparte; sin cuerpo, la de siempre", async () => {
    const order = await account();
    await issue(order.id, { suggestedTipPct: 15 });
    expect((await shown(order.id)).paper.tipRows).toEqual([{ label: "Propina sugerida (voluntaria) 15%", amount: money(1_800_000) }]);
    const other = await account();
    await issue(other.id);
    const plain = await shown(other.id);
    expect(plain.snapshot.suggestedTipPct).toBeUndefined();
    expect(plain.paper.tipRows).toEqual([{ label: "Propina sugerida (voluntaria) 10%", amount: money(TIP) }]);
  });

  it("sin cobrar: TOTAL A PAGAR = total factura; la propina sugerida va aparte, sin sumar", async () => {
    const order = await account();
    expect((await issue(order.id)).status).toBe(200);
    const { snapshot, payable, paper } = await shown(order.id);
    expect(snapshot).toMatchObject({ issuedBeforePayment: true, tipCents: 0, totalCents: SALE });
    expect(payable).toEqual({ invoiceTotalCents: SALE, tipCents: 0, totalToPayCents: SALE });
    expect(paper.totals.at(-1)).toEqual({ label: "TOTAL A PAGAR", amount: money(SALE), strong: true });
    expect(paper.pendingRow).toEqual({ label: "Pendiente de pago", amount: money(SALE), bold: true });
    expect(paper.tipRows).toEqual([{ label: "Propina sugerida (voluntaria) 10%", amount: money(TIP) }]);
  });

  it.each([
    ["efectivo", async (orderId: string) => {
      await pay(json({ orderId, method: "cash", amountCents: SALE + TIP, tipCents: TIP, settleNow: true }), tenantParams());
    }],
    ["datáfono del comercio", async (orderId: string) => {
      const requested = await read(await requestExternalTerminal(json({ orderId, amountCents: SALE + TIP, tipCents: TIP }), tenantParams()));
      await settleExternalTerminal(json({ action: "approve" }), idParams(requested.body.paymentId));
    }],
    ["dividida: efectivo sin propina + datáfono del comercio con propina", async (orderId: string) => {
      await pay(json({ orderId, method: "cash", amountCents: SALE / 2, tipCents: 0, settleNow: true }), tenantParams());
      const requested = await read(await requestExternalTerminal(json({ orderId, amountCents: SALE / 2 + TIP, tipCents: TIP }), tenantParams()));
      await settleExternalTerminal(json({ action: "approve" }), idParams(requested.body.paymentId));
    }],
  ])("cobrada después (%s): el snapshot sigue en 0 y el TOTAL A PAGAR lleva la propina cobrada", async (_name, charge) => {
    const order = await account();
    await issue(order.id);
    await charge(order.id);
    await expectTotalToPay(order.id, { sale: SALE, tip: TIP });
    const { snapshot, paper } = await shown(order.id);
    // La factura (y el XML) no cambió: la propina nunca entra en ella.
    expect(snapshot).toMatchObject({ issuedBeforePayment: true, tipCents: 0, totalCents: SALE });
    expect(await db.simpleInvoice.count({ where: { orderId: order.id } })).toBe(1);
    expect(paper.pendingRow ?? null).toBeNull();
    expect(paper.tipRows ?? []).toEqual([]);
  });
});
