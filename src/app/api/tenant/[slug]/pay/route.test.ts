import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Regresión del P0 #1: la ruta pública de pago aceptaba `demo_card` /
 * `demo_nequi` y creaba un Payment `approved` sin pasarela y sin sesión.
 * El comensal ve su propio orderId en la URL, así que le bastaba un POST
 * para cerrar la cuenta sin pagar.
 *
 * Lo que estos tests blindan:
 *   1. En producción un método demo NO produce NINGUNA escritura.
 *   2. El cobro en EFECTIVO (demo_cash) sigue funcionando en producción,
 *      tanto el pending del comensal como el cobro del mesero.
 *   3. En desarrollo los demo siguen andando (así se prueba la app).
 *
 * Toda escritura pasa por `writes`: si alguien reintroduce el agujero,
 * el array deja de estar vacío y el test falla.
 */

const h = vi.hoisted(() => {
  const writes: string[] = [];
  const record = (label: string) =>
    vi.fn(async (args: unknown) => {
      writes.push(label);
      return { id: `${label}-id`, ...(args as object) };
    });
  const tx = {
    payment: {
      create: record("payment.create"),
      updateMany: record("payment.updateMany"),
    },
    order: { update: record("order.update"), findUniqueOrThrow: vi.fn(async () => ({ id: "order-1", status: "open" })) },
  };
  const db = {
    restaurant: {
      findUnique: vi.fn(async () => ({ id: "rest-1", slug: "chefburger" })),
    },
    order: {
      findFirst: vi.fn(async () => ({
        id: "order-1",
        restaurantId: "rest-1",
        status: "open",
        tableId: null,
        dinerId: null,
        locale: "es",
      })),
      update: record("order.update"),
    },
    payment: {
      create: record("payment.create"),
      updateMany: record("payment.updateMany"),
    },
    table: { findUnique: vi.fn(async () => null) },
    $transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
  };
  const auth = vi.fn(async () => null as unknown);
  const validateNewPaymentAmount = vi.fn(async () => ({ ok: true }));
  const recomputeOrderTotalsInTx = vi.fn(async () => ({ fullyPaid: false }));
  return { writes, db, tx, auth, validateNewPaymentAmount, recomputeOrderTotalsInTx };
});

vi.mock("@/lib/db", () => ({ db: h.db }));
vi.mock("@/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/orderTotals", () => ({
  validateNewPaymentAmount: h.validateNewPaymentAmount,
  recomputeOrderTotalsInTx: h.recomputeOrderTotalsInTx,
}));
vi.mock("@/lib/events", () => ({ publishOrderEvent: vi.fn() }));
vi.mock("@/lib/mailer", () => ({ welcomeIfFirstTime: vi.fn(async () => {}) }));
vi.mock("@/lib/prepaidRounds", () => ({ activateOpenRounds: vi.fn(async () => {}) }));
vi.mock("@/lib/push", () => ({ sendPushToMeserosForTable: vi.fn(async () => {}) }));
vi.mock("@/lib/meseroShift", () => ({
  meseroNeedsShiftToCharge: vi.fn(async () => false),
}));

type Body = Record<string, unknown>;

/**
 * Recarga la ruta con el ambiente pedido. `env` cachea process.env en el
 * primer acceso, así que sin resetModules el segundo caso vería el
 * ambiente del primero.
 */
async function post(
  body: Body,
  environment: { NODE_ENV: string; MESAPAY_ALLOW_DEMO_PAYMENTS?: string },
) {
  vi.resetModules();
  vi.stubEnv("DATABASE_URL", "postgresql://u:p@localhost:5432/test");
  vi.stubEnv("MESAPAY_ALLOW_DEMO_PAYMENTS", undefined);
  vi.stubEnv("NODE_ENV", environment.NODE_ENV);
  if (environment.MESAPAY_ALLOW_DEMO_PAYMENTS != null) {
    vi.stubEnv(
      "MESAPAY_ALLOW_DEMO_PAYMENTS",
      environment.MESAPAY_ALLOW_DEMO_PAYMENTS,
    );
  }
  const { POST } = await import("./route");
  const res = await POST(
    new Request("http://localhost/api/tenant/chefburger/pay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ slug: "chefburger" }) },
  );
  return { res, json: (await res.json()) as Record<string, unknown> };
}

const PROD = { NODE_ENV: "production" };
const DEV = { NODE_ENV: "development" };

beforeEach(() => {
  h.writes.length = 0;
  h.auth.mockResolvedValue(null);
  vi.clearAllMocks();
  h.db.restaurant.findUnique.mockResolvedValue({
    id: "rest-1",
    slug: "chefburger",
  });
  h.db.order.findFirst.mockResolvedValue({
    id: "order-1",
    restaurantId: "rest-1",
    status: "open",
    tableId: null,
    dinerId: null,
    locale: "es",
  });
  h.validateNewPaymentAmount.mockResolvedValue({ ok: true });
  h.recomputeOrderTotalsInTx.mockResolvedValue({ fullyPaid: false });
  h.db.$transaction.mockImplementation(async (cb) => cb(h.tx));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/tenant/[slug]/pay — gate de pagos demo", () => {
  for (const method of ["demo_card", "demo_nequi"]) {
    it(`en producción rechaza ${method} sin escribir nada`, async () => {
      const { res, json } = await post(
        { orderId: "order-1", method, amountCents: 4300000, tipCents: 0 },
        PROD,
      );

      expect(res.status).toBe(403);
      expect(json.error).toBe("demo_payments_disabled");
      // Lo importante: cero escrituras financieras.
      expect(h.writes).toEqual([]);
      expect(h.db.$transaction).not.toHaveBeenCalled();
      expect(h.db.payment.create).not.toHaveBeenCalled();
      // Y ni siquiera llegamos a leer la orden: cortamos antes.
      expect(h.db.order.findFirst).not.toHaveBeenCalled();
    });
  }

  it("en desarrollo demo_card sigue aprobando (así se prueba la app)", async () => {
    const { res, json } = await post(
      { orderId: "order-1", method: "demo_card", amountCents: 4300000 },
      DEV,
    );

    expect(res.status).toBe(200);
    expect(json.paymentId).toBeDefined();
    expect(h.tx.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ method: "demo_card", status: "approved" }),
      }),
    );
  });

  it("MESAPAY_ALLOW_DEMO_PAYMENTS=true reabre los demo en un staging production-like", async () => {
    const { res } = await post(
      { orderId: "order-1", method: "demo_card", amountCents: 4300000 },
      { NODE_ENV: "production", MESAPAY_ALLOW_DEMO_PAYMENTS: "true" },
    );

    expect(res.status).toBe(200);
    expect(h.tx.payment.create).toHaveBeenCalled();
  });
});

describe("POST /api/tenant/[slug]/pay — el efectivo NO se rompe", () => {
  it("en producción el comensal puede pedir cobro en efectivo (pending)", async () => {
    const { res, json } = await post(
      { orderId: "order-1", method: "demo_cash", amountCents: 4300000, tipCents: 0 },
      PROD,
    );

    expect(res.status).toBe(200);
    expect(json.pending).toBe(true);
    expect(h.tx.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ method: "demo_cash", status: "pending" }),
      }),
    );
  });

  it("en producción el mesero con sesión cierra el cobro en efectivo (approved)", async () => {
    h.auth.mockResolvedValue({
      user: { id: "user-1", role: "mesero" },
    });

    const { res, json } = await post(
      {
        orderId: "order-1",
        method: "demo_cash",
        amountCents: 4300000,
        tipCents: 300000,
        settleNow: true,
      },
      PROD,
    );

    expect(res.status).toBe(200);
    expect(json.pending).toBe(false);
    expect(h.tx.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          method: "demo_cash",
          status: "approved",
          collectedByUserId: "user-1",
        }),
      }),
    );
  });
});

vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));

vi.mock("@/lib/orderLock", () => ({ lockOrder: vi.fn(async () => {}) }));
vi.mock("@/lib/activeRestaurant", () => ({ getActiveContext: async () => {
  const session = await h.auth();
  return session ? { restaurantId: "rest-1", session } : null;
} }));
vi.mock("@/lib/invoiceOnPaid", () => ({ issueRequestedInvoiceOnPaid: vi.fn(async () => {}) }));
vi.mock("@/lib/billRequest", () => ({ announceBillRequestedOnPay: vi.fn(async () => {}) }));
