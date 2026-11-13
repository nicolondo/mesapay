import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Llave maestra de PRUEBA (cifra las llaves Bre-B de los comercios de prueba).
vi.hoisted(() => {
  process.env.MESAPAY_SECRET_KEY ??= "ab".repeat(32);
});

import { db } from "../src/lib/db";
import { encrypt, decrypt } from "../src/lib/crypto";
import { KushkiHttpError } from "../src/lib/payments/kushki/client";
import { PendingPaymentInFlightError } from "../src/lib/payments/paymentInFlight";
import { POST as startBreB } from "../src/app/api/tenant/[slug]/pay/bre-b/route";
import { POST as breBAction, GET as breBView } from "../src/app/api/tenant/[slug]/payment/[paymentId]/bre-b/route";
import { POST as payCash } from "../src/app/api/tenant/[slug]/pay/route";
import { POST as kushkiWebhook } from "../src/app/api/webhooks/kushki/route";
import {
  DELETE as breBCredsDelete,
  GET as breBCredsGet,
  PUT as breBCredsPut,
} from "../src/app/api/admin/restaurants/[id]/kushki/bre-b/route";
import { PUT as putMethods } from "../src/app/api/admin/restaurants/[id]/payment-methods/route";
import {
  checkBreBCharge,
  handleBreBWebhookEvent,
  startLinkBreBCharge,
  sweepBreBCharges,
} from "../src/lib/payments/breB/service";
import { reconcilePayment } from "../src/lib/payments/reconciliation";
import { resolveEnabledPaymentMethods } from "../src/lib/paymentMethods";

/**
 * Bre-B de punta a punta contra PostgreSQL (trigger de reserva, motor de
 * cobro, factura). Kushki NO se llama: el gateway es un doble que responde
 * con la forma del contrato y que cada caso programa.
 */

const QR = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const gw = vi.hoisted(() => ({
  processor: { name: "Bre-B Test Processor", channel: "QR" } as { name: string; channel: string } | null,
  initError: null as unknown,
  statusResult: null as null | { status: "approved" | "declined" | "pending"; amountCents: number | null },
  statusError: null as unknown,
  cancelError: null as unknown,
  cancels: [] as string[],
  tokens: [] as string[],
}));

vi.mock("../src/lib/payments/breB/gateway", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/lib/payments/breB/gateway")>();
  const fake = {
    processor: async () => gw.processor,
    forgetProcessor: () => {},
    requestToken: async () => {
      const token = `tok-${randomUUID()}`;
      gw.tokens.push(token);
      return { token };
    },
    init: async () => {
      if (gw.initError) throw gw.initError;
      return { qrImage: QR, transactionReference: `ref-${randomUUID()}`, ticketNumber: `${Date.now()}` };
    },
    status: async (token: string) => {
      if (gw.statusError) throw gw.statusError;
      const r = gw.statusResult ?? { status: "pending" as const, amountCents: null };
      return { ...r, currency: null, token, transactionReference: null, ticketNumber: null };
    },
    cancel: async (token: string) => {
      gw.cancels.push(token);
      if (gw.cancelError) throw gw.cancelError;
    },
  };
  return { ...orig, breBGatewayFor: () => fake };
});

const scope = vi.hoisted(() => ({ restaurantId: "", userId: "", role: "operator", loggedIn: false }));
vi.mock("../src/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("../src/auth", () => ({
  auth: async () => (scope.loggedIn ? { user: { id: scope.userId, role: scope.role, email: "staff@example.test", restaurantId: scope.restaurantId } } : null),
}));
vi.mock("../src/lib/activeRestaurant", () => ({
  getActiveRestaurantId: async () => scope.restaurantId,
  getActiveContext: async () =>
    scope.loggedIn ? { restaurantId: scope.restaurantId, session: { user: { id: scope.userId, role: scope.role } } } : null,
}));
vi.mock("../src/lib/events", () => ({ publishOrderEvent: vi.fn() }));
vi.mock("../src/lib/mailer", () => ({ welcomeIfFirstTime: vi.fn(async () => undefined), sendEmail: vi.fn() }));
vi.mock("../src/lib/invoiceDelivery", () => ({ deliverInvoiceEmail: vi.fn(async () => undefined) }));
const printQueue = vi.hoisted(() => ({ enqueue: vi.fn(async () => undefined) }));
vi.mock("../src/lib/print/invoiceQueue", () => ({ enqueueInvoicePrintSafe: printQueue.enqueue }));
vi.mock("../src/lib/kds/autoFireTickets", () => ({ notifyAutoFiredTickets: vi.fn(async () => undefined) }));
vi.mock("../src/lib/push", () => ({ sendPushToMeserosForTable: vi.fn(async () => undefined) }));
vi.mock("../src/lib/billRequest", () => ({ announceBillRequestedOnPay: vi.fn(async () => undefined) }));

const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["localhost", "127.0.0.1"].includes(database.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname)) {
  throw new Error("Isolated local database required");
}

// Respuesta JSON de una ruta, tal como la lee el test.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = Record<string, any>;

const tenants: string[] = [];
let slug = "";
let tableId = "";
const TOTAL = 4_550_000; // $45.500

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/test", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const tenantParams = () => ({ params: Promise.resolve({ slug }) });
const paymentParams = (paymentId: string) => ({ params: Promise.resolve({ slug, paymentId }) });
const adminParams = () => ({ params: Promise.resolve({ id: scope.restaurantId }) });

async function start(orderId: string, amountCents = TOTAL, tipCents = 0, key?: string) {
  const res = await startBreB(
    json({ orderId, amountCents, tipCents }, key ? { "idempotency-key": key } : {}),
    tenantParams(),
  );
  return { status: res.status, body: (await res.json()) as Body };
}
async function action(paymentId: string, body: Record<string, unknown>) {
  const res = await breBAction(json(body), paymentParams(paymentId));
  return { status: res.status, body: (await res.json()) as Body };
}
async function webhook(body: Record<string, unknown>) {
  const res = await kushkiWebhook(json(body));
  return { status: res.status, body: (await res.json()) as Body };
}
const approvedBody = (
  charge: { id: string; token: string | null; paymentId: string | null; ticketNumber: string | null; transactionReference: string | null },
  cents = TOTAL,
) => ({
  token: charge.token,
  status: "approvedTransaction",
  // Las mismas referencias que devolvió el init (como las manda Kushki).
  ticketNumber: charge.ticketNumber,
  transactionReference: charge.transactionReference,
  amount: { subtotalIva: 0, subtotalIva0: cents / 100, iva: 0 },
  metadata: { breBChargeId: charge.id, paymentId: charge.paymentId },
});

async function account(subtotalCents = TOTAL) {
  return db.order.create({
    data: {
      restaurantId: scope.restaurantId, tableId, shortCode: randomUUID(), status: "placed",
      subtotalCents, taxCents: 0, discountCents: 0, totalCents: subtotalCents, simpleInvoiceEmail: "",
      items: { create: { nameSnapshot: "Bre-B fixture", priceCentsSnapshot: subtotalCents } },
    },
  });
}
const chargeOf = (paymentId: string) => db.breBCharge.findUniqueOrThrow({ where: { paymentId } });
const paymentOf = (id: string) => db.payment.findUniqueOrThrow({ where: { id } });

beforeEach(async () => {
  Object.assign(gw, { processor: { name: "Bre-B Test Processor", channel: "QR" }, initError: null, statusResult: null, statusError: null, cancelError: null, cancels: [], tokens: [] });
  printQueue.enqueue.mockClear();
  const tenant = await db.restaurant.create({
    data: {
      name: "Bre-B fixture", slug: `breb-${randomUUID()}`, country: "CO", kushkiMode: "sandbox",
      salesTaxKind: "none", salesTaxPct: 0, enabledModules: [],
      enabledPaymentMethods: ["kushki_bre_b", "cash"],
      kushkiBreBPublicKey: "pub-breb-test-fake",
      kushkiBreBPrivateKeyEnc: encrypt("priv-breb-test-fake"),
    },
  });
  tenants.push(tenant.id);
  const user = await db.user.create({ data: { restaurantId: tenant.id, role: "operator", email: `${randomUUID()}@example.test`, passwordHash: "test-only" } });
  const table = await db.table.create({ data: { restaurantId: tenant.id, number: 1, qrToken: randomUUID() } });
  Object.assign(scope, { restaurantId: tenant.id, userId: user.id, role: "operator", loggedIn: false });
  slug = tenant.slug;
  tableId = table.id;
});
afterAll(async () => {
  try {
    await db.restaurant.deleteMany({ where: { id: { in: tenants } } });
  } finally {
    await db.$disconnect();
  }
});

describe("crear el cobro", () => {
  it("reserva el pago pendiente y devuelve el QR (PNG) con su vencimiento a 10 minutos", async () => {
    const order = await account();
    const before = Date.now();
    const { status, body } = await start(order.id);
    expect(status).toBe(200);
    expect(body.charge).toMatchObject({ state: "active", amountCents: TOTAL, currency: "COP", qrImage: QR });
    const payment = await paymentOf(body.paymentId);
    expect(payment).toMatchObject({ method: "kushki_bre_b", status: "pending", amountCents: TOTAL });
    const charge = await chargeOf(payment.id);
    expect(charge).toMatchObject({ status: "active", processorName: "Bre-B Test Processor", mode: "sandbox" });
    const ttl = charge.expiresAt!.getTime() - before;
    expect(ttl).toBeGreaterThan(590_000);
    expect(ttl).toBeLessThanOrEqual(600_000 + 5_000);
    // GET devuelve el mismo QR (para retomarlo al recargar).
    const view = await (await breBView(new Request("http://localhost/x"), paymentParams(payment.id))).json();
    expect(view.charge.qrImage).toBe(QR);
  });

  it("un reintento con la misma llave devuelve el MISMO cobro, sin otro QR", async () => {
    const order = await account();
    const key = randomUUID();
    const first = await start(order.id, TOTAL, 0, key);
    const again = await start(order.id, TOTAL, 0, key);
    expect(again.body.paymentId).toBe(first.body.paymentId);
    expect(gw.tokens).toHaveLength(1);
  });

  it("concurrencia: dos cobros por todo el saldo, sólo uno gana", async () => {
    const order = await account();
    const results = await Promise.allSettled([start(order.id), start(order.id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.payment.count({ where: { orderId: order.id, status: { in: ["pending", "approved"] } } })).toBe(1);
  });

  it("mientras el QR está vivo nadie cobra esa parte por otro medio (ni el comensal en efectivo)", async () => {
    const order = await account();
    await start(order.id);
    await expect(
      payCash(json({ orderId: order.id, method: "cash", amountCents: TOTAL, tipCents: 0 }), tenantParams()),
    ).rejects.toThrow(/amount_exceeds_outstanding/);
  });

  it("el staff no puede cobrar por encima de un Bre-B en vuelo: error accionable", async () => {
    const order = await account();
    await start(order.id);
    scope.loggedIn = true;
    await expect(
      payCash(json({ orderId: order.id, method: "cash", amountCents: TOTAL, tipCents: 0, settleNow: true }), tenantParams()),
    ).rejects.toBeInstanceOf(PendingPaymentInFlightError);
  });

  it("el staff cobra con Bre-B y reemplaza la solicitud de efectivo del comensal", async () => {
    const order = await account();
    const cash = await (await payCash(json({ orderId: order.id, method: "cash", amountCents: TOTAL, tipCents: 0 }), tenantParams())).json();
    scope.loggedIn = true;
    const { status, body } = await start(order.id);
    expect(status).toBe(200);
    expect(await paymentOf(cash.paymentId)).toMatchObject({ status: "declined" });
    expect(await paymentOf(body.paymentId)).toMatchObject({ status: "pending", collectedByUserId: scope.userId });
  });

  it("sin procesador Bre-B en la config de Kushki: no hay cobro y la cuenta queda libre", async () => {
    gw.processor = null;
    const order = await account();
    const { status, body } = await start(order.id);
    expect(status).toBe(409);
    expect(body.error).toBe("bre_b_processor_unavailable");
    expect(await paymentOf(body.paymentId)).toMatchObject({ status: "declined" });
  });

  it("init 422 E046 / 404 E049 / 401: rechazo definitivo, se libera la cuenta con su código", async () => {
    for (const [status, code, error] of [
      [422, "E046", "bre_b_processor_mismatch"],
      [404, "E049", "bre_b_keys_missing"],
      [401, "", "bre_b_credentials_invalid"],
    ] as const) {
      gw.initError = new KushkiHttpError(status, code ? JSON.stringify({ code }) : "", "u");
      const order = await account();
      const res = await start(order.id);
      expect(res.status).toBe(502);
      expect(res.body.error).toBe(error);
      expect(await paymentOf(res.body.paymentId)).toMatchObject({ status: "declined" });
      expect(gw.cancels).toHaveLength(0);
    }
  });

  it("init sin respuesta (5xx) y Kushki confirma la cancelación: se libera y se puede cobrar en efectivo", async () => {
    gw.initError = new KushkiHttpError(503, "down", "u");
    const order = await account();
    const res = await start(order.id);
    expect(res.status).toBe(502);
    expect(gw.cancels).toHaveLength(1);
    expect(await paymentOf(res.body.paymentId)).toMatchObject({ status: "declined" });
    scope.loggedIn = true;
    const cash = await payCash(json({ orderId: order.id, method: "cash", amountCents: TOTAL, tipCents: 0, settleNow: true }), tenantParams());
    expect(cash.status).toBe(200);
  });

  it("init sin respuesta y la cancelación tampoco responde: queda pendiente para conciliar (falla cerrado)", async () => {
    gw.initError = new KushkiHttpError(504, "timeout", "u");
    gw.cancelError = new KushkiHttpError(503, "down", "u");
    gw.statusError = new KushkiHttpError(503, "down", "u");
    const order = await account();
    const res = await start(order.id);
    expect(res.status).toBe(202);
    expect(res.body.charge.state).toBe("uncertain");
    expect(await paymentOf(res.body.paymentId)).toMatchObject({ status: "pending", reconciliationRequired: true });
  });
});

describe("resultado: webhook y consulta de estado", () => {
  it("aprobado con el monto correcto: se salda como cualquier medio (factura e impresión automática)", async () => {
    const order = await account();
    const { body } = await start(order.id);
    const charge = await chargeOf(body.paymentId);
    const res = await webhook(approvedBody(charge));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
    expect(await paymentOf(body.paymentId)).toMatchObject({ status: "approved", reconciliationRequired: false });
    expect(await db.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: "paid" });
    expect(await db.simpleInvoice.count({ where: { orderId: order.id } })).toBe(1);
    expect(printQueue.enqueue).toHaveBeenCalledTimes(1);
    expect(await chargeOf(body.paymentId)).toMatchObject({ status: "approved", ticketNumber: charge.ticketNumber });
  });

  it("un aviso con OTRA referencia (ticket distinto al del init) no se salda", async () => {
    const order = await account();
    const { body } = await start(order.id);
    const charge = await chargeOf(body.paymentId);
    const res = await webhook({ ...approvedBody(charge), ticketNumber: "000-otro-ticket" });
    expect(res.body.status).toBe("review");
    expect(await chargeOf(body.paymentId)).toMatchObject({ status: "uncertain", failureCode: "reference_mismatch" });
    expect(await paymentOf(body.paymentId)).toMatchObject({ status: "pending", reconciliationRequired: true });
  });

  it("el mismo aviso dos veces cuenta una sola vez", async () => {
    const order = await account();
    const { body } = await start(order.id);
    const charge = await chargeOf(body.paymentId);
    await webhook(approvedBody(charge));
    const again = await webhook(approvedBody(charge));
    expect(again.status).toBe(200);
    expect(await db.kushkiWebhookEvent.count({ where: { eventId: `breb:${charge.id}:approved` } })).toBe(1);
    expect(await db.simpleInvoice.count({ where: { orderId: order.id } })).toBe(1);
    expect(await db.payment.count({ where: { orderId: order.id, status: "approved" } })).toBe(1);
  });

  it("aprobado por OTRO monto: no se salda, va a conciliación con rastro", async () => {
    const order = await account();
    const { body } = await start(order.id);
    const charge = await chargeOf(body.paymentId);
    const res = await webhook(approvedBody(charge, TOTAL - 100_00));
    expect(res.body.status).toBe("review");
    expect(await paymentOf(body.paymentId)).toMatchObject({ status: "pending", reconciliationRequired: true });
    expect(await chargeOf(body.paymentId)).toMatchObject({ status: "uncertain", failureCode: "amount_mismatch" });
    expect(await db.order.findUniqueOrThrow({ where: { id: order.id } })).not.toMatchObject({ status: "paid" });
    expect(await db.auditEvent.count({ where: { restaurantId: scope.restaurantId, kind: "payment.bre_b_review" } })).toBe(1);
    // Cancelar no lo destraba a ciegas: se resuelve en Cobros.
    const cancel = await action(body.paymentId, { action: "cancel" });
    expect(cancel.body.charge.state).toBe("uncertain");
    expect(gw.cancels).toHaveLength(0);
  });

  it("aviso de OTRO cobro (metadata ajena): no se salda", async () => {
    const order = await account();
    const { body } = await start(order.id);
    const charge = await chargeOf(body.paymentId);
    const handled = await handleBreBWebhookEvent(
      charge,
      { status: "approved", amountCents: TOTAL, currency: "COP", token: "otro-token", transactionReference: null, ticketNumber: null,
        metadata: { chargeId: null, paymentId: null, orderId: null, paymentLinkId: null }, merchantId: null },
      {},
    );
    expect(handled).toBe("review");
    expect(await paymentOf(body.paymentId)).toMatchObject({ status: "pending", reconciliationRequired: true });
  });

  it("rechazado: la cuenta queda libre", async () => {
    const order = await account();
    const { body } = await start(order.id);
    const charge = await chargeOf(body.paymentId);
    const res = await webhook({ ...approvedBody(charge), status: "declinedTransaction" });
    expect(res.body.status).toBe("closed");
    expect(await paymentOf(body.paymentId)).toMatchObject({ status: "declined" });
    expect(await chargeOf(body.paymentId)).toMatchObject({ status: "declined" });
  });

  it("la consulta de estado (polling) aprueba si Kushki lo dice y el monto cuadra", async () => {
    const order = await account();
    const { body } = await start(order.id);
    gw.statusResult = { status: "approved", amountCents: TOTAL };
    const res = await action(body.paymentId, { action: "check" });
    expect(res.body.charge.state).toBe("approved");
    expect(res.body.charge.orderPaid).toBe(true);
  });

  it("venció sin pago: se cancela en Kushki y se cierra como vencido", async () => {
    const order = await account();
    const { body } = await start(order.id);
    await db.breBCharge.update({ where: { paymentId: body.paymentId }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    const res = await sweepBreBCharges();
    expect(res.resolved).toBeGreaterThanOrEqual(1);
    expect(gw.cancels).toHaveLength(1);
    expect(await chargeOf(body.paymentId)).toMatchObject({ status: "expired" });
    expect(await paymentOf(body.paymentId)).toMatchObject({ status: "declined" });
  });
});

describe("cancelar", () => {
  it("cancelado y después llega la aprobación: no se pierde, queda aprobado y para conciliar", async () => {
    const order = await account();
    const { body } = await start(order.id);
    const cancel = await action(body.paymentId, { action: "cancel" });
    expect(cancel.body.charge.state).toBe("canceled");
    expect(await paymentOf(body.paymentId)).toMatchObject({ status: "declined" });
    const charge = await chargeOf(body.paymentId);
    const late = await webhook(approvedBody(charge));
    expect(late.status).toBe(200);
    expect(await paymentOf(body.paymentId)).toMatchObject({ status: "approved", reconciliationRequired: true });
    expect(await chargeOf(body.paymentId)).toMatchObject({ status: "approved", failureCode: "late_approval" });
    expect(await db.auditEvent.count({ where: { restaurantId: scope.restaurantId, kind: "payment.bre_b_late_approval" } })).toBe(1);
  });

  it("400 T023 al cancelar: ya había resultado final; si fue aprobado, se salda", async () => {
    const order = await account();
    const { body } = await start(order.id);
    gw.cancelError = new KushkiHttpError(400, JSON.stringify({ code: "T023" }), "u");
    gw.statusResult = { status: "approved", amountCents: TOTAL };
    const cancel = await action(body.paymentId, { action: "cancel" });
    expect(cancel.body.charge.state).toBe("approved");
    expect(await paymentOf(body.paymentId)).toMatchObject({ status: "approved" });
  });

  it("400 T023 y el resultado real es rechazado: se libera como rechazado", async () => {
    const order = await account();
    const { body } = await start(order.id);
    gw.cancelError = new KushkiHttpError(400, JSON.stringify({ code: "T023" }), "u");
    gw.statusResult = { status: "declined", amountCents: TOTAL };
    const cancel = await action(body.paymentId, { action: "cancel" });
    expect(cancel.body.charge.state).toBe("declined");
    expect(await paymentOf(body.paymentId)).toMatchObject({ status: "declined" });
  });

  it("sin confirmación de Kushki: sin confirmar (no se libera), y se recupera al consultar", async () => {
    const order = await account();
    const { body } = await start(order.id);
    gw.cancelError = new KushkiHttpError(503, "down", "u");
    gw.statusError = new KushkiHttpError(503, "down", "u");
    const cancel = await action(body.paymentId, { action: "cancel" });
    expect(cancel.body.charge.state).toBe("uncertain");
    expect(await paymentOf(body.paymentId)).toMatchObject({ status: "pending", reconciliationRequired: true });
    gw.statusError = null;
    gw.statusResult = { status: "declined", amountCents: TOTAL };
    scope.loggedIn = true;
    const check = await action(body.paymentId, { action: "check", force: true });
    expect(check.body.charge.state).toBe("declined");
    expect(await paymentOf(body.paymentId)).toMatchObject({ status: "declined" });
  });

  it("conciliar a mano en Cobros también cierra el intento", async () => {
    const order = await account();
    const { body } = await start(order.id);
    gw.cancelError = new KushkiHttpError(503, "down", "u");
    gw.statusError = new KushkiHttpError(503, "down", "u");
    await action(body.paymentId, { action: "cancel" });
    await reconcilePayment({
      paymentId: body.paymentId, restaurantId: scope.restaurantId, outcome: "approved",
      evidence: "Comprobante del banco verificado con Kushki", providerRef: "ref-manual-1",
      actor: { id: scope.userId, email: "staff@example.test", role: "operator" },
    });
    expect(await paymentOf(body.paymentId)).toMatchObject({ status: "approved", reconciliationRequired: false });
    expect(await chargeOf(body.paymentId)).toMatchObject({ status: "approved", failureCode: "reconciled" });
  });
});

describe("link de pago de monto fijo", () => {
  it("un solo QR vivo por link; aprobado, el link queda pagado con Bre-B", async () => {
    const link = await db.paymentLink.create({
      data: { restaurantId: scope.restaurantId, token: randomUUID(), kind: "voucher_batch", amountCents: 1_200_000, currency: "COP" },
    });
    const tenant = await db.restaurant.findUniqueOrThrow({ where: { id: scope.restaurantId } });
    const first = await startLinkBreBCharge({ tenant, link });
    const second = await startLinkBreBCharge({ tenant, link });
    expect(first.ok && second.ok && first.view.chargeId === second.view.chargeId).toBe(true);
    const charge = await db.breBCharge.findFirstOrThrow({ where: { paymentLinkId: link.id } });
    await webhook({ ...approvedBody(charge, 1_200_000) });
    expect(await db.paymentLink.findUniqueOrThrow({ where: { id: link.id } })).toMatchObject({ status: "paid", method: "kushki_bre_b" });
    expect(await checkBreBCharge(charge.id)).toMatchObject({ status: "approved" });
  });
});

describe("credenciales Bre-B y habilitación (admin de plataforma)", () => {
  const put = async (body: unknown) => {
    const res = await breBCredsPut(json(body), adminParams());
    return { status: res.status, body: (await res.json()) as Body };
  };

  it("sólo el admin de plataforma; las llaves se cifran y nunca vuelven enteras", async () => {
    scope.loggedIn = true;
    scope.role = "operator";
    expect((await put({ publicKey: "pub-new-fake-1234", privateKey: "priv-new-fake-5678" })).status).toBe(403);

    scope.role = "platform_admin";
    const saved = await put({ publicKey: "pub-new-fake-1234", privateKey: "priv-new-fake-5678", webhookSecret: "whsec-fake-9999", merchantName: "Bre-B Demo" });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ configured: true, publicKeyTail: "••••1234", privateKeyTail: "••••5678", webhookSecretTail: "••••9999" });
    expect(JSON.stringify(saved.body)).not.toContain("priv-new-fake-5678");
    expect(JSON.stringify(saved.body)).not.toContain("pub-new-fake-1234");
    const row = await db.restaurant.findUniqueOrThrow({ where: { id: scope.restaurantId } });
    expect(row.kushkiBreBPrivateKeyEnc).not.toContain("priv-new-fake");
    expect(decrypt(row.kushkiBreBPrivateKeyEnc!)).toBe("priv-new-fake-5678");
    expect(decrypt(row.kushkiBreBWebhookSecretEnc!)).toBe("whsec-fake-9999");

    const get = await (await breBCredsGet(new Request("http://localhost/x"), adminParams())).json();
    expect(JSON.stringify(get)).not.toContain("priv-new-fake-5678");
    expect(await db.auditEvent.count({ where: { restaurantId: scope.restaurantId, kind: { startsWith: "restaurant.kushki_bre_b_credentials" } } })).toBe(1);
    const audit = await db.auditEvent.findFirstOrThrow({ where: { restaurantId: scope.restaurantId, kind: { startsWith: "restaurant.kushki_bre_b" } } });
    expect(JSON.stringify(audit.diff)).not.toContain("priv-new-fake");
  });

  it("rechaza las llaves de tarjeta/PSE y exige las dos llaves", async () => {
    scope.loggedIn = true;
    scope.role = "platform_admin";
    await db.restaurant.update({ where: { id: scope.restaurantId }, data: { kushkiPublicKey: "card-pub-fake", kushkiPrivateKeyEnc: encrypt("card-priv-fake"), kushkiBreBPublicKey: null, kushkiBreBPrivateKeyEnc: null } });
    expect((await put({ publicKey: "card-pub-fake", privateKey: "other-priv-fake" })).body.error).toBe("same_as_card_keys");
    expect((await put({ publicKey: "other-pub-fake", privateKey: "card-priv-fake" })).body.error).toBe("same_as_card_keys");
    expect((await put({ publicKey: "only-public-fake" })).body.error).toBe("keys_required");
  });

  it("no se reemplazan ni se borran con un cobro en curso; borrarlas apaga el medio", async () => {
    const order = await account();
    await start(order.id);
    scope.loggedIn = true;
    scope.role = "platform_admin";
    expect((await put({ publicKey: "pub-other-fake-0000", privateKey: "priv-other-fake-0000" })).body.error).toBe("bre_b_charges_in_flight");
    expect((await breBCredsDelete(new Request("http://localhost/x", { method: "DELETE" }), adminParams())).status).toBe(409);

    await db.breBCharge.updateMany({ where: { restaurantId: scope.restaurantId }, data: { status: "canceled" } });
    const cleared = await breBCredsDelete(new Request("http://localhost/x", { method: "DELETE" }), adminParams());
    expect(cleared.status).toBe(200);
    const row = await db.restaurant.findUniqueOrThrow({ where: { id: scope.restaurantId } });
    expect(row.kushkiBreBPrivateKeyEnc).toBeNull();
    expect(resolveEnabledPaymentMethods(row.enabledPaymentMethods)).not.toContain("kushki_bre_b");
  });

  it("Bre-B nace apagado y no se puede encender sin credenciales", async () => {
    expect(resolveEnabledPaymentMethods(null)).not.toContain("kushki_bre_b");
    scope.loggedIn = true;
    scope.role = "platform_admin";
    await db.restaurant.update({ where: { id: scope.restaurantId }, data: { kushkiBreBPublicKey: null, kushkiBreBPrivateKeyEnc: null } });
    const blocked = await putMethods(new Request("http://localhost/x", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ methods: ["cash", "kushki_bre_b"] }) }), adminParams());
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error).toBe("bre_b_credentials_required");
    await put({ publicKey: "pub-ok-fake-1111", privateKey: "priv-ok-fake-2222" });
    const ok = await putMethods(new Request("http://localhost/x", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ methods: ["cash", "kushki_bre_b"] }) }), adminParams());
    expect(ok.status).toBe(200);
  });

  it("sin llaves Bre-B el cobro no arranca aunque el medio figure habilitado", async () => {
    await db.restaurant.update({ where: { id: scope.restaurantId }, data: { kushkiBreBPrivateKeyEnc: null } });
    const order = await account();
    const res = await start(order.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("bre_b_not_configured");
    expect(await db.payment.count({ where: { orderId: order.id } })).toBe(0);
  });
});
