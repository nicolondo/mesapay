import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePaymentsDb } from "@/test/fakePaymentsDb";

/**
 * "Cancelar solicitud": declina un pendiente que es sólo una solicitud
 * (efectivo, datáfono propio, datáfono Kushki sin enviar) y nunca uno en
 * vuelo. Ruta real con `secureApi` real contra la base en memoria con el
 * trigger de reserva y los reclamos `terminal:<id>`.
 */

const h = vi.hoisted(() => ({
  fake: null as unknown as ReturnType<typeof import("@/test/fakePaymentsDb").createFakePaymentsDb>,
  session: null as null | { user: { id: string; role: string; email?: string } },
  activeRestaurantId: "rest-1",
  adminOnlyCharge: false,
  publish: vi.fn(),
  // Corre justo después de la lectura previa (fuera de la transacción):
  // simula a otro proceso que alcanza a escribir antes de que tomemos el lock.
  afterPreRead: null as null | (() => void),
}));

vi.mock("@/lib/db", () => ({
  db: {
    restaurant: { findUnique: vi.fn(async () => ({ id: "rest-1", suspended: false, adminOnlyCharge: h.adminOnlyCharge })) },
    payment: {
      findUnique: async (a: never) => {
        const row = await h.fake.tx.payment.findUnique(a);
        const hook = h.afterPreRead;
        h.afterPreRead = null;
        hook?.();
        return row;
      },
    },
    $transaction: (cb: never) => h.fake.$transaction(cb),
  },
}));
vi.mock("@/auth", () => ({ auth: async () => h.session }));
vi.mock("@/lib/activeRestaurant", () => ({
  getActiveContext: async () => (h.session ? { restaurantId: h.activeRestaurantId, session: h.session } : null),
  getActiveRestaurantId: async () => h.activeRestaurantId,
}));
vi.mock("@/lib/rateLimit", () => ({ rateLimit: async () => true }));
vi.mock("@/lib/orderLock", () => ({ lockOrder: async () => {} }));
vi.mock("@/lib/events", () => ({ publishOrderEvent: h.publish }));

import { POST } from "./route";

const ORDER_ID = "order-7";
const TOTAL = 17_457_000;
const TIP = 1_587_000;

function seed(
  payments: Parameters<typeof createFakePaymentsDb>[0]["payments"],
  extra: Partial<Parameters<typeof createFakePaymentsDb>[0]> = {},
) {
  h.fake = createFakePaymentsDb({
    order: { id: ORDER_ID, status: "paying", subtotalCents: TOTAL - TIP },
    payments,
    rounds: [{ status: "served" }],
    ...extra,
  });
}

async function cancel(paymentId: string) {
  const res = await POST(
    new Request(`http://localhost/api/operator/payments/${paymentId}/cancel-request`, {
      method: "POST",
      headers: { host: "localhost" },
    }),
    { params: Promise.resolve({ id: paymentId }) },
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const ADMIN = { user: { id: "admin-1", role: "operator", email: "admin@sonymelona.co" } };
const MESERO = { user: { id: "mesero-1", role: "mesero", email: "mesero@sonymelona.co" } };
const kushki = { id: "smart", method: "kushki_card_terminal", status: "pending", amountCents: TOTAL, tipCents: TIP };

beforeEach(() => {
  vi.clearAllMocks();
  h.session = ADMIN;
  h.activeRestaurantId = "rest-1";
  h.adminOnlyCharge = false;
  h.afterPreRead = null;
});

describe("cancel-request: una solicitud se declina", () => {
  it("datáfono Kushki que nunca se envió: declined, la orden sale de paying, evento y auditoría", async () => {
    seed([{ ...kushki, reconciliationRequired: true }]);

    const { status, json } = await cancel("smart");

    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, status: "declined", orderStatus: "served" });
    expect(h.fake.payment("smart")).toMatchObject({ status: "declined", reconciliationRequired: false });
    // Sin pagos pendientes ni aprobados, la cuenta vuelve al estado de su cocina.
    expect(h.fake.order().status).toBe("served");
    expect(h.publish).toHaveBeenCalledWith("rest-1", { type: "order.updated", orderId: ORDER_ID });
    expect(h.publish).toHaveBeenCalledWith("rest-1", expect.objectContaining({ type: "payment.declined", paymentId: "smart" }));
    expect(h.fake.state.auditEvents).toEqual([
      expect.objectContaining({
        restaurantId: "rest-1",
        actorUserId: "admin-1",
        actorRole: "operator",
        kind: "payment.request_cancelled",
        targetType: "payment",
        targetId: "smart",
      }),
    ]);
  });

  it.each(["cash", "external_terminal"])("también cancela la solicitud de %s pedida desde el QR", async (method) => {
    seed([{ id: "req", method, status: "pending", amountCents: TOTAL, tipCents: TIP }]);
    const { status } = await cancel("req");
    expect(status).toBe(200);
    expect(h.fake.payment("req")?.status).toBe("declined");
  });

  it("si queda otro pago aprobado, la orden sigue en paying", async () => {
    seed([
      { id: "half", method: "cash", status: "approved", amountCents: 5_000_000, tipCents: 0 },
      { ...kushki, amountCents: 10_870_000, tipCents: 0 },
    ]);
    const { status, json } = await cancel("smart");
    expect(status).toBe(200);
    expect(json.orderStatus).toBeNull();
    expect(h.fake.order().status).toBe("paying");
  });

  it("con el pendiente cancelado, el staff ya puede cobrar el total por otro lado (el trigger lo deja)", async () => {
    seed([kushki]);
    await cancel("smart");
    await expect(
      h.fake.tx.payment.create({ data: { orderId: ORDER_ID, method: "cash", status: "approved", amountCents: TOTAL, tipCents: TIP } }),
    ).resolves.toMatchObject({ status: "approved" });
  });
});

describe("cancel-request: lo que está en vuelo no se toca", () => {
  it("datáfono Kushki YA enviado (reclamo terminal:<id>) → 409 pending_payment_in_flight", async () => {
    seed([kushki], { financialOperations: [{ key: "terminal:smart", paymentId: "smart" }] });
    const { status, json } = await cancel("smart");
    expect(status).toBe(409);
    expect(json).toMatchObject({ error: "pending_payment_in_flight", pending: { paymentId: "smart", method: "kushki_card_terminal" } });
    expect(h.fake.payment("smart")?.status).toBe("pending");
    expect(h.fake.state.auditEvents).toHaveLength(0);
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("datáfono Kushki con providerRef → 409, en vuelo", async () => {
    seed([{ ...kushki, providerRef: "mock-ref-1" }]);
    expect((await cancel("smart")).status).toBe(409);
    expect(h.fake.payment("smart")?.status).toBe("pending");
  });

  it.each(["kushki_pse", "kushki_card", "kushki_apple_pay"])("%s en curso → 409, nunca se cancela", async (method) => {
    seed([{ id: "online", method, status: "pending", amountCents: TOTAL, tipCents: TIP }]);
    const { status, json } = await cancel("online");
    expect(status).toBe(409);
    expect(json.error).toBe("pending_payment_in_flight");
    expect(h.fake.payment("online")?.status).toBe("pending");
  });

  it("carrera: el datáfono se empujó entre la lectura y el lock → 409 y nada cambia", async () => {
    seed([kushki]);
    h.afterPreRead = () => {
      h.fake.state.financialOperations.push({
        key: "terminal:smart",
        paymentId: "smart",
        kind: "terminal",
        amountCents: TOTAL,
        status: "pending",
        providerRef: null,
        createdAt: new Date(),
      });
    };
    const { status, json } = await cancel("smart");
    expect(status).toBe(409);
    expect(json.error).toBe("pending_payment_in_flight");
    expect(h.fake.payment("smart")?.status).toBe("pending");
  });

  it("carrera: el pago se resolvió entre la lectura y el lock → conflicto, no lo pisa", async () => {
    seed([kushki]);
    h.afterPreRead = () => {
      h.fake.state.payments[0].status = "approved";
    };
    const { status, json } = await cancel("smart");
    expect(status).toBe(409);
    expect(json.error).toBe("operation_conflict");
    expect(h.fake.payment("smart")?.status).toBe("approved");
  });

  it("ya resuelto → 409 already_settled", async () => {
    seed([{ ...kushki, status: "declined" }]);
    expect(await cancel("smart")).toMatchObject({ status: 409, json: { error: "already_settled" } });
  });
});

describe("cancel-request: permisos", () => {
  it("el mesero puede cancelar si el cobro no está reservado al administrador", async () => {
    seed([kushki]);
    h.session = MESERO;
    expect((await cancel("smart")).status).toBe(200);
  });

  it("«solo el administrador cobra»: el mesero recibe 403 charge_admin_only y nada cambia", async () => {
    seed([kushki]);
    h.adminOnlyCharge = true;
    h.session = MESERO;
    expect(await cancel("smart")).toMatchObject({ status: 403, json: { error: "charge_admin_only" } });
    expect(h.fake.payment("smart")?.status).toBe("pending");
  });

  it("«solo el administrador cobra»: el administrador sí puede", async () => {
    seed([kushki]);
    h.adminOnlyCharge = true;
    expect((await cancel("smart")).status).toBe(200);
  });

  it.each(["kitchen", "bar", "diner"])("el rol %s no puede", async (role) => {
    seed([kushki]);
    h.session = { user: { id: "x", role } };
    expect((await cancel("smart")).status).toBe(401);
    expect(h.fake.payment("smart")?.status).toBe("pending");
  });

  it("sin sesión → 401", async () => {
    seed([kushki]);
    h.session = null;
    expect((await cancel("smart")).status).toBe(401);
  });

  it("un pago de otro comercio → 403", async () => {
    seed([kushki]);
    h.activeRestaurantId = "otro";
    expect((await cancel("smart")).status).toBe(403);
    expect(h.fake.payment("smart")?.status).toBe("pending");
  });

  it("un pago que no existe → 404", async () => {
    seed([]);
    expect((await cancel("nope")).status).toBe(404);
  });
});
