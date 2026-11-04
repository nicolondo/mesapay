import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePaymentsDb } from "@/test/fakePaymentsDb";

/**
 * «Reintentar en el datáfono» / «Cancelar y cobrar de otra forma» sobre un
 * cobro del datáfono Kushki YA enviado (reclamo `terminal:<id>`) que no se
 * aprobó (Son y Melona, 2026-11-04). Lo que se puede hacer depende de lo que
 * se sabe del intento:
 *
 *   - el equipo contestó que no → las dos acciones al instante, mesero
 *     incluido, con confirmación y auditoría;
 *   - en curso → «Cancelar» sólo le pide al equipo que cancele (abort), sin
 *     tocar el pago;
 *   - sin respuesta → nada acá: "Resolver cobro" (administrador, 3 minutos,
 *     evidencia).
 *
 * Rutas reales (terminal-attempt, terminal/charge, pay y resolve-terminal)
 * con `secureApi` real contra la base en memoria con el trigger de reserva.
 * Kushki NUNCA se llama: el cobro y el abort del Cloud Terminal son dobles.
 */

const h = vi.hoisted(() => ({
  fake: null as unknown as ReturnType<typeof import("@/test/fakePaymentsDb").createFakePaymentsDb>,
  session: null as null | { user: { id: string; role: string; email?: string; restaurantId?: string } },
  adminOnlyCharge: false,
  push: vi.fn(),
  abort: vi.fn(),
  publish: vi.fn(),
  // Corre después de la lectura previa de una ruta (fuera de su
  // transacción): otro proceso que se adelanta.
  afterPreRead: null as null | (() => Promise<void>),
}));

const TENANT = {
  id: "rest-1",
  slug: "sonymelona",
  name: "Son y Melona",
  country: "CO",
  suspended: false,
  enabledPaymentMethods: ["cash", "kushki_card_terminal"],
  kushkiMode: "production",
  cloudTerminalBusinessCode: "bc-test",
  get adminOnlyCharge() {
    return h.adminOnlyCharge;
  },
};
const DEVICE = { id: "dev-1", kushkiDeviceId: "kd-1", restaurantId: "rest-1", active: true, serialNumber: "P3F6P624J0139", label: "Caja" };

vi.mock("@/lib/db", () => ({
  db: {
    restaurant: { findUnique: vi.fn(async () => TENANT) },
    order: {
      findFirst: (a: never) => h.fake.tx.order.findFirst(a),
      findUnique: (a: never) => h.fake.tx.order.findUnique(a),
    },
    payment: {
      findUnique: async (a: { include?: { order?: boolean } }) => {
        const row = await h.fake.tx.payment.findUnique(a as never);
        if (a.include?.order && h.afterPreRead) {
          const hook = h.afterPreRead;
          h.afterPreRead = null;
          await hook();
        }
        return row;
      },
      findMany: (a: never) => h.fake.tx.payment.findMany(a),
      updateMany: (a: never) => h.fake.tx.payment.updateMany(a),
    },
    financialOperation: {
      findUnique: (a: never) => h.fake.tx.financialOperation.findUnique(a),
      updateMany: (a: never) => h.fake.tx.financialOperation.updateMany(a),
    },
    terminalDevice: {
      findUnique: vi.fn(async () => DEVICE),
      findMany: vi.fn(async () => [DEVICE]),
      update: vi.fn(async () => DEVICE),
    },
    table: { findUnique: vi.fn(async () => null) },
    $transaction: (cb: never) => h.fake.$transaction(cb),
  },
}));
vi.mock("@/auth", () => ({ auth: async () => h.session }));
vi.mock("@/lib/activeRestaurant", () => ({
  getActiveContext: async () => (h.session ? { restaurantId: "rest-1", session: h.session } : null),
  getActiveRestaurantId: async () => "rest-1",
}));
vi.mock("@/lib/rateLimit", () => ({ rateLimit: async () => true }));
vi.mock("@/lib/guestAccess", () => ({ canAccessOrder: async () => true, canAccessTable: async () => true }));
vi.mock("@/lib/orderLock", () => ({ lockOrder: async () => {} }));
vi.mock("@/lib/waiterCommissionsSeal", () => ({ sealOrderCommission: async () => {} }));
vi.mock("@/lib/events", () => ({ publishOrderEvent: h.publish }));
vi.mock("@/lib/mailer", () => ({ welcomeIfFirstTime: async () => {} }));
vi.mock("@/lib/prepaidRounds", () => ({ activateOpenRounds: async () => [] }));
vi.mock("@/lib/kds/autoFireTickets", () => ({ notifyAutoFiredTickets: async () => {} }));
vi.mock("@/lib/push", () => ({ sendPushToMeserosForTable: async () => {} }));
vi.mock("@/lib/meseroShift", () => ({ meseroNeedsShiftToCharge: async () => false }));
vi.mock("@/lib/invoiceOnPaid", () => ({ issueInvoiceOnPaid: async () => ({ status: "skipped" }) }));
vi.mock("@/lib/billRequest", () => ({ announceBillRequestedOnPay: async () => {} }));
vi.mock("@/lib/platformConfig", () => ({
  getRestaurantKushkiMode: async (r: { kushkiMode?: string | null }) => r.kushkiMode ?? "mock",
}));
vi.mock("@/lib/billing/countries", () => ({ getCurrencyForCountry: async () => "COP" }));
vi.mock("@/lib/payments/kushki/cloudTerminal", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/payments/kushki/cloudTerminal")>()),
  pushPaymentToCloudTerminal: h.push,
  cancelCloudTerminalPayment: h.abort,
}));
vi.mock("@/lib/payments/mockBridge", () => ({ ensureMockBridge: () => {} }));
vi.mock("@/lib/payments/webhookHandler", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/payments/webhookHandler")>()),
  processKushkiWebhook: vi.fn(async () => ({ status: "ok" })),
}));
vi.mock("@/lib/payments", () => ({ getPaymentProvider: vi.fn() }));

import { POST as ATTEMPT } from "./route";
import { POST as CHARGE } from "@/app/api/tenant/[slug]/terminal/charge/route";
import { POST as PAY } from "@/app/api/tenant/[slug]/pay/route";
import { POST as RESOLVE } from "../resolve-terminal/route";

const ORDER_ID = "order-11";
const TOTAL = 9_185_000; // $91.850
const TIP = 835_000;
const OLD = "smart-1";
const PUSHED_AT = new Date("2026-11-04T18:00:00Z");
const at = (ms: number) => new Date(PUSHED_AT.getTime() + ms);

const MESERO = { user: { id: "mesero-1", role: "mesero", email: "camila@sonymelona.co", restaurantId: "rest-1" } };
const ADMIN = { user: { id: "admin-1", role: "operator", email: "admin@sonymelona.co", restaurantId: "rest-1" } };

type Kind = "answered" | "in_flight" | "no_answer";

/** Un cobro de $91.850 enviado al datáfono, en el estado pedido. */
function seed(kind: Kind) {
  h.fake = createFakePaymentsDb({
    order: { id: ORDER_ID, status: "paying", subtotalCents: TOTAL - TIP },
    payments: [
      {
        id: OLD,
        method: "kushki_card_terminal",
        status: "pending",
        amountCents: TOTAL,
        tipCents: TIP,
        collectedByUserId: "mesero-1",
        reconciliationRequired: kind !== "in_flight",
      },
    ],
    financialOperations: [
      {
        key: `terminal:${OLD}`,
        paymentId: OLD,
        amountCents: TOTAL,
        createdAt: PUSHED_AT,
        deviceId: "kd-1",
        ...(kind === "answered"
          ? {
              answerCode: "TERMINAL/TER-003",
              answerMessage: "Terminal P3F6P624J0139 is busy processing transaction",
              answeredAt: at(40_000),
            }
          : {}),
      },
    ],
    rounds: [{ status: "served" }],
  });
}

const json = (body: unknown) => ({
  method: "POST",
  headers: { host: "localhost", "content-type": "application/json" },
  body: JSON.stringify(body),
});

async function attempt(body: Record<string, unknown>, paymentId = OLD) {
  const res = await ATTEMPT(new Request(`http://localhost/api/operator/payments/${paymentId}/terminal-attempt`, json(body)), {
    params: Promise.resolve({ id: paymentId }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function charge(paymentId: string, deviceId = "kd-1") {
  const res = await CHARGE(new Request(`http://localhost/api/tenant/${TENANT.slug}/terminal/charge`, json({ paymentId, deviceId })), {
    params: Promise.resolve({ slug: TENANT.slug }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function payCash() {
  const res = await PAY(
    new Request(
      `http://localhost/api/tenant/${TENANT.slug}/pay`,
      json({ orderId: ORDER_ID, method: "cash", amountCents: TOTAL, tipCents: TIP, settleNow: true }),
    ),
    { params: Promise.resolve({ slug: TENANT.slug }) },
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function resolveTerminal(body: Record<string, unknown>) {
  const res = await RESOLVE(new Request(`http://localhost/api/operator/payments/${OLD}/resolve-terminal`, json(body)), {
    params: Promise.resolve({ id: OLD }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const claims = () => h.fake.state.financialOperations;
const terminalPayments = () => h.fake.state.payments.filter((p) => p.method === "kushki_card_terminal");

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DATABASE_URL", "postgresql://u:p@localhost:5432/test");
  vi.useFakeTimers({ toFake: ["Date"] });
  // 1 minuto después del envío: dentro de la ventana del cobro síncrono.
  vi.setSystemTime(at(60_000));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  h.session = MESERO;
  h.adminOnlyCharge = false;
  h.afterPreRead = null;
  h.abort.mockResolvedValue({ status: "aborted", httpStatus: 200 });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("el datáfono contestó que no: «Cancelar y cobrar de otra forma»", () => {
  it("el mesero lo cierra al instante: no cobrado, reclamo failed, cuenta libre, auditoría y eventos", async () => {
    seed("answered");
    const { status, json } = await attempt({ action: "cancel", confirmed: true });

    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, status: "declined", orderStatus: "served" });
    expect(h.fake.payment(OLD)).toMatchObject({ status: "declined", reconciliationRequired: false });
    expect(claims()[0]).toMatchObject({ key: `terminal:${OLD}`, status: "failed", nextPaymentId: null });
    expect(h.fake.order().status).toBe("served");
    expect(h.fake.state.auditEvents).toEqual([
      expect.objectContaining({
        kind: "payment.terminal_attempt_cancelled",
        actorUserId: "mesero-1",
        actorRole: "mesero",
        targetId: OLD,
        diff: expect.objectContaining({ answerCode: "TERMINAL/TER-003", confirmedOnDevice: true, deviceId: "kd-1" }),
      }),
    ]);
    expect(h.publish).toHaveBeenCalledWith("rest-1", { type: "order.updated", orderId: ORDER_ID });
    expect(h.publish).toHaveBeenCalledWith("rest-1", expect.objectContaining({ type: "payment.declined", paymentId: OLD, reason: "terminal_canceled" }));
    expect(h.abort).not.toHaveBeenCalled();
    // Y ahora sí se cobra en efectivo.
    expect(await payCash()).toMatchObject({ status: 200, json: { paid: true } });
  });

  it("sin la confirmación de que el cobro no salió, no toca nada", async () => {
    seed("answered");
    expect(await attempt({ action: "cancel" })).toMatchObject({ status: 400, json: { error: "confirmation_required" } });
    expect(h.fake.payment(OLD)).toMatchObject({ status: "pending", reconciliationRequired: true });
    expect(h.fake.state.auditEvents).toHaveLength(0);
  });

  it("con «solo el administrador cobra», el mesero no puede (403 charge_admin_only)", async () => {
    seed("answered");
    h.adminOnlyCharge = true;
    expect(await attempt({ action: "cancel", confirmed: true })).toMatchObject({ status: 403, json: { error: "charge_admin_only" } });
    expect(h.fake.payment(OLD)?.status).toBe("pending");
  });

  it("dos personas a la vez: la segunda ve el pago ya cerrado", async () => {
    seed("answered");
    expect((await attempt({ action: "cancel", confirmed: true })).status).toBe(200);
    expect(await attempt({ action: "cancel", confirmed: true })).toMatchObject({ status: 409, json: { error: "already_settled" } });
    expect(h.fake.state.auditEvents).toHaveLength(1);
  });
});

describe("el datáfono contestó que no: «Reintentar en el datáfono»", () => {
  it("cierra el intento y deja UN pago nuevo por el mismo monto, que se empuja al mismo equipo con un solo reclamo en vuelo", async () => {
    seed("answered");
    const retry = await attempt({ action: "retry", confirmed: true });

    expect(retry.status).toBe(200);
    expect(retry.json).toMatchObject({ ok: true, status: "retry", deviceId: "kd-1" });
    const next = retry.json.paymentId as string;
    expect(h.fake.payment(OLD)).toMatchObject({ status: "declined", reconciliationRequired: false });
    expect(h.fake.payment(next)).toMatchObject({
      method: "kushki_card_terminal",
      status: "pending",
      amountCents: TOTAL,
      tipCents: TIP,
      collectedByUserId: "mesero-1",
    });
    expect(claims()[0]).toMatchObject({ status: "failed", nextPaymentId: next });
    // La cuenta sigue "pagando": hay un cobro nuevo en camino.
    expect(h.fake.order().status).toBe("paying");
    expect(h.fake.state.auditEvents).toEqual([expect.objectContaining({ kind: "payment.terminal_retried" })]);

    // La pantalla lo empuja por el camino de siempre.
    h.push.mockImplementation(async () => {
      // Mientras el datáfono espera la tarjeta: un solo reclamo pendiente,
      // el del pago nuevo, y nadie puede cobrar en efectivo.
      expect(claims().filter((c) => c.status === "pending").map((c) => c.key)).toEqual([`terminal:${next}`]);
      expect((await payCash()).json.error).toBe("pending_payment_in_flight");
      return { status: "approved", providerRef: "tx-ok", message: "ok", raw: {} };
    });
    expect(await charge(next, retry.json.deviceId as string)).toMatchObject({ status: 200, json: { ok: true, status: "approved" } });
    expect(h.push).toHaveBeenCalledOnce();
    expect(h.push).toHaveBeenCalledWith(expect.objectContaining({ serialNumber: "P3F6P624J0139", amountCents: TOTAL, reference: next }));
    expect(claims().find((c) => c.key === `terminal:${next}`)).toMatchObject({ deviceId: "kd-1" });
    expect(h.fake.state.payments.filter((p) => p.method === "cash")).toHaveLength(0);
  });

  it("si el reintento vuelve cancelado, la cuenta queda libre otra vez", async () => {
    seed("answered");
    const next = (await attempt({ action: "retry", confirmed: true })).json.paymentId as string;
    h.push.mockResolvedValue({
      status: "canceled",
      providerRef: "c-2",
      message: "TERMINAL/TER-004: User cancel the process",
      deviceAnswered: true,
      failure: { type: "TERMINAL", code: "TER-004", message: "User cancel the process" },
      raw: {},
    });
    expect(await charge(next)).toMatchObject({ status: 402, json: { status: "canceled", error: "terminal_canceled" } });
    expect(claims().find((c) => c.key === `terminal:${next}`)).toMatchObject({ answerCode: "TERMINAL/TER-004" });
  });

  it("reintento vs. efectivo, el reintento primero: el efectivo reemplaza el pago nuevo y el empuje rebota sin llamar a Kushki", async () => {
    seed("answered");
    const next = (await attempt({ action: "retry", confirmed: true })).json.paymentId as string;
    // Otro mesero cobra en efectivo antes de que la pantalla empuje el reintento.
    expect(await payCash()).toMatchObject({ status: 200, json: { paid: true } });
    const pushed = await charge(next);

    expect(pushed.status).toBe(409);
    expect(h.push).not.toHaveBeenCalled();
    expect(terminalPayments().map((p) => p.status)).toEqual(["declined", "declined"]);
    expect(h.fake.state.payments.filter((p) => p.status === "approved")).toHaveLength(1);
    expect(h.fake.order().status).toBe("paid");
  });

  it("reintento vs. efectivo, el efectivo primero: rebota con el intento en vuelo y el reintento sigue", async () => {
    seed("answered");
    expect((await payCash()).json.error).toBe("pending_payment_in_flight");
    const retry = await attempt({ action: "retry", confirmed: true });
    expect(retry.status).toBe(200);
    expect(h.fake.state.payments.filter((p) => p.method === "cash")).toHaveLength(0);
  });

  it("reintento vs. efectivo que se cuela entre la lectura y el lock: sólo uno gana", async () => {
    seed("answered");
    // El efectivo llega mientras el reintento todavía no tomó el lock: el
    // intento viejo sigue en vuelo, así que el efectivo rebota.
    let cash: Awaited<ReturnType<typeof payCash>> | null = null;
    h.afterPreRead = async () => {
      cash = await payCash();
    };
    const retry = await attempt({ action: "retry", confirmed: true });
    expect(cash).toMatchObject({ status: 409, json: { error: "pending_payment_in_flight" } });
    expect(retry.status).toBe(200);
    expect(h.fake.state.payments.filter((p) => p.status === "approved")).toHaveLength(0);
    expect(terminalPayments().filter((p) => p.status === "pending")).toHaveLength(1);
  });

  it("dos reintentos a la vez no dejan dos cobros", async () => {
    seed("answered");
    expect((await attempt({ action: "retry", confirmed: true })).status).toBe(200);
    expect(await attempt({ action: "retry", confirmed: true })).toMatchObject({ status: 409, json: { error: "already_settled" } });
    expect(terminalPayments().filter((p) => p.status === "pending")).toHaveLength(1);
  });
});

describe("todavía en curso: «Cancelar» sólo le pide al equipo que cancele", () => {
  it("llama al abort del equipo y NO toca el pago (la respuesta del cobro lo libera)", async () => {
    seed("in_flight");
    const { status, json } = await attempt({ action: "cancel" });

    expect(status).toBe(202);
    expect(json).toEqual({ ok: true, status: "abort_requested", abort: "aborted" });
    expect(h.abort).toHaveBeenCalledWith("P3F6P624J0139", OLD, "bc-test", "production");
    expect(h.fake.payment(OLD)).toMatchObject({ status: "pending", reconciliationRequired: false });
    expect(claims()[0]).toMatchObject({ status: "pending" });
    expect(h.fake.state.auditEvents).toEqual([expect.objectContaining({ kind: "payment.terminal_abort_requested" })]);
    // Sigue bloqueando: el datáfono todavía puede aprobar.
    expect((await payCash()).json.error).toBe("pending_payment_in_flight");
  });

  it("no se puede reintentar mientras el equipo puede responder", async () => {
    seed("in_flight");
    expect(await attempt({ action: "retry", confirmed: true })).toMatchObject({ status: 409, json: { error: "terminal_result_pending" } });
    expect(h.fake.payment(OLD)?.status).toBe("pending");
  });

  it("pasada la ventana del cobro síncrono sin respuesta ya no está en curso: es «sin respuesta»", async () => {
    seed("in_flight");
    vi.setSystemTime(at(150_000 + 1_000));
    expect(await attempt({ action: "cancel" })).toMatchObject({ status: 409, json: { error: "terminal_no_answer" } });
    expect(h.abort).not.toHaveBeenCalled();
  });
});

describe("sin respuesta del equipo: sigue siendo «Resolver cobro»", () => {
  it.each([
    ["el mesero", MESERO],
    ["el administrador", ADMIN],
  ])("%s no puede cerrarlo por acá (409 terminal_no_answer)", async (_label, session) => {
    seed("no_answer");
    h.session = session;
    for (const action of ["cancel", "retry"]) {
      expect(await attempt({ action, confirmed: true })).toMatchObject({ status: 409, json: { error: "terminal_no_answer" } });
    }
    expect(h.fake.payment(OLD)).toMatchObject({ status: "pending", reconciliationRequired: true });
    expect(h.abort).not.toHaveBeenCalled();
  });

  it("resolve-terminal sigue exigiendo administrador, 3 minutos y evidencia", async () => {
    seed("no_answer");
    const DECLINE = { outcome: "declined", evidence: "El datáfono no muestra el cobro y no imprimió voucher", confirmed: true };
    // El mesero, nunca.
    vi.setSystemTime(at(3 * 60_000 + 1_000));
    expect(await resolveTerminal(DECLINE)).toMatchObject({ status: 403 });
    // El administrador, antes de 3 minutos, no.
    h.session = ADMIN;
    vi.setSystemTime(at(2 * 60_000));
    expect(await resolveTerminal(DECLINE)).toMatchObject({ status: 409, json: { error: "terminal_result_pending" } });
    // Sin evidencia, no.
    vi.setSystemTime(at(3 * 60_000 + 1_000));
    expect(await resolveTerminal({ outcome: "declined", evidence: "corto", confirmed: true })).toMatchObject({ status: 400 });
    // Con todo, sí.
    expect(await resolveTerminal(DECLINE)).toMatchObject({ status: 200, json: { ok: true, status: "declined" } });
    expect(h.fake.payment(OLD)?.status).toBe("declined");
  });
});

describe("lo que no es un intento enviado", () => {
  it("una solicitud que nunca se envió se cancela con cancel-request (409 terminal_not_sent)", async () => {
    h.fake = createFakePaymentsDb({
      order: { id: ORDER_ID, status: "paying", subtotalCents: TOTAL - TIP },
      payments: [{ id: OLD, method: "kushki_card_terminal", status: "pending", amountCents: TOTAL, tipCents: TIP }],
    });
    expect(await attempt({ action: "cancel", confirmed: true })).toMatchObject({ status: 409, json: { error: "terminal_not_sent" } });
  });

  it("roles que no cobran no entran", async () => {
    seed("answered");
    h.session = { user: { id: "k-1", role: "kitchen", restaurantId: "rest-1" } };
    expect((await attempt({ action: "cancel", confirmed: true })).status).toBe(403);
    expect(h.fake.payment(OLD)?.status).toBe("pending");
  });
});
