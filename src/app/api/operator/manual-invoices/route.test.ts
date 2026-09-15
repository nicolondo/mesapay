import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Abrir una factura manual = una mesa oculta `kind = manual` por factura
 * abierta + una Order vacía sobre ella. Lo que importa:
 *   - sólo caja (operador / quien lo impersona); mesero y cocina rebotan;
 *   - todo va SIEMPRE al comercio de la sesión, nunca a uno del body;
 *   - reutiliza una mesa manual libre antes de crear otra;
 *   - la nueva baja de a uno desde -100 (nunca -1).
 */
const m = vi.hoisted(() => {
  const tx = {
    $executeRaw: vi.fn(async () => 1),
    table: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
    },
    order: { create: vi.fn() },
  };
  return {
    auth: vi.fn(),
    active: vi.fn(),
    audit: vi.fn(async () => {}),
    event: vi.fn(),
    tx,
    transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/activeRestaurant", () => ({ getActiveRestaurantId: m.active }));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/lib/db", () => ({ db: { $transaction: m.transaction } }));
vi.mock("@/lib/auditLog", () => ({ recordAuditEvent: m.audit }));
vi.mock("@/lib/events", () => ({ publishOrderEvent: m.event }));
vi.mock("next-intl/server", () => ({ getLocale: vi.fn(async () => "es") }));

import { POST } from "./route";

const post = (body: unknown = {}) =>
  POST(
    new Request("http://localhost/api/operator/manual-invoices", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  vi.resetAllMocks();
  m.auth.mockResolvedValue({ user: { id: "user-1", role: "operator" } });
  m.active.mockResolvedValue("rest-1");
  m.transaction.mockImplementation(async (fn) => fn(m.tx));
  m.tx.$executeRaw.mockResolvedValue(1);
  m.tx.table.findFirst.mockResolvedValue(null);
  m.tx.table.findMany.mockResolvedValue([]);
  m.tx.table.create.mockResolvedValue({ id: "table-new", number: -100 });
  m.tx.order.create.mockResolvedValue({ id: "order-1", shortCode: "AAAAAA-BBBBBB" });
});

describe("POST /api/operator/manual-invoices", () => {
  it.each([
    null,
    { user: { id: "w", role: "mesero" } },
    { user: { id: "k", role: "kitchen" } },
    { user: { id: "b", role: "bar" } },
    { user: { id: "c", role: "customer" } },
  ])("rechaza a quien no es caja: %j", async (session) => {
    m.auth.mockResolvedValue(session);
    const res = await post();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it("sin comercio activo no escribe nada", async () => {
    m.active.mockResolvedValue(null);
    const res = await post();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "no_restaurant" });
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it("reutiliza una mesa manual libre antes de crear otra", async () => {
    m.tx.table.findFirst.mockResolvedValue({ id: "table-free", number: -100 });

    const res = await post();

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      orderId: "order-1",
      tableId: "table-free",
      shortCode: "AAAAAA-BBBBBB",
    });
    // Sólo mesas manuales del comercio de la sesión, y sólo las que no
    // tienen cuenta viva.
    expect(m.tx.table.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          restaurantId: "rest-1",
          kind: "manual",
          orders: { none: { status: { notIn: ["paid", "cancelled"] } } },
        },
      }),
    );
    expect(m.tx.table.create).not.toHaveBeenCalled();
    expect(m.tx.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          restaurantId: "rest-1",
          tableId: "table-free",
          status: "open",
          locale: "es",
        }),
      }),
    );
    // Serializa a dos cajeros abriendo a la vez en el mismo comercio.
    expect(m.tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(m.event).toHaveBeenCalledWith("rest-1", {
      type: "order.updated",
      orderId: "order-1",
    });
    expect(m.audit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "order.manual_invoice.open", restaurantId: "rest-1" }),
    );
  });

  it("sin mesa manual libre crea una nueva bajando desde -100", async () => {
    m.tx.table.findFirst.mockResolvedValue(null);
    // Mesas físicas, la de recogida (-1) y una manual ocupada (-100).
    m.tx.table.findMany.mockResolvedValue([
      { number: 1 },
      { number: 2 },
      { number: -1 },
      { number: -100 },
    ]);
    m.tx.table.create.mockResolvedValue({ id: "table-new", number: -101 });

    const res = await post();

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ tableId: "table-new" });
    expect(m.tx.table.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          restaurantId: "rest-1",
          number: -101,
          kind: "manual",
          reservable: false,
          qrToken: expect.any(String),
        }),
      }),
    );
    expect(m.tx.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tableId: "table-new", status: "open" }),
      }),
    );
  });

  it("la primera factura manual de un comercio sin ninguna es la -100", async () => {
    m.tx.table.findMany.mockResolvedValue([{ number: 1 }, { number: -1 }]);
    await post();
    expect(m.tx.table.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ number: -100 }) }),
    );
  });

  it("ignora cualquier comercio que venga en el body: manda el de la sesión", async () => {
    m.tx.table.findFirst.mockResolvedValue(null);
    await post({ restaurantId: "foreign", tableId: "foreign-table" });
    expect(m.tx.table.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ restaurantId: "rest-1" }) }),
    );
    expect(m.tx.table.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { restaurantId: "rest-1" } }),
    );
    expect(m.tx.table.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ restaurantId: "rest-1" }) }),
    );
    expect(m.tx.order.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ restaurantId: "rest-1" }) }),
    );
  });

  it("quien impersona al operador (admin de plataforma o de grupo) también abre", async () => {
    for (const role of ["platform_admin", "group_admin"]) {
      m.auth.mockResolvedValue({ user: { id: "a", role } });
      expect((await post()).status).toBe(201);
    }
  });
});
