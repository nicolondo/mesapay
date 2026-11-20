// Desplegable «Platos cancelados» de la ficha de la mesa: el endpoint sólo
// mira cuentas del comercio activo y resuelve nombres con el personal de ese
// mismo comercio, en consultas fijas (sin una por plato).
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  active: vi.fn(),
  orderFindFirst: vi.fn(),
  userFindMany: vi.fn(),
  currency: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/activeRestaurant", () => ({ getActiveRestaurantId: m.active }));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/lib/billing/countries", () => ({ getCurrencyForCountry: m.currency }));
vi.mock("@/lib/db", () => ({
  db: {
    order: { findFirst: m.orderFindFirst },
    user: { findMany: m.userFindMany },
  },
}));

import { GET } from "./route";

const call = () =>
  GET(new Request("http://localhost/api/operator/orders/order-1/cancelled-items"), {
    params: Promise.resolve({ id: "order-1" }),
  });

const at = (hhmm: string) => new Date(`2026-11-19T${hhmm}:00.000Z`);

beforeEach(() => {
  vi.clearAllMocks();
  m.auth.mockResolvedValue({ user: { role: "mesero", email: "camila@demo.test" } });
  m.active.mockResolvedValue("rest-1");
  m.currency.mockResolvedValue("COP");
  m.orderFindFirst.mockResolvedValue({
    restaurant: { country: "CO" },
    rounds: [
      { id: "r1", seq: 1, status: "served", cancelledAt: null, cancelledByEmail: null, cancellationReason: null },
      { id: "r2", seq: 2, status: "cancelled", cancelledAt: at("20:10"), cancelledByEmail: "cocina@demo.test", cancellationReason: "Sin gas" },
    ],
    items: [
      { id: "i1", roundId: "r1", nameSnapshot: "Lomito", qty: 1, priceCentsSnapshot: 3_200_000, cancelledAt: at("20:30"), cancelledByEmail: "camila@demo.test", cancellationReason: "Error al tomar pedido", cancellationKind: "cancel" },
      { id: "i2", roundId: "r2", nameSnapshot: "Limonada", qty: 2, priceCentsSnapshot: 800_000, cancelledAt: null, cancelledByEmail: null, cancellationReason: null, cancellationKind: null },
    ],
  });
  m.userFindMany.mockResolvedValue([{ email: "camila@demo.test", name: "Camila" }]);
});

describe("GET /api/operator/orders/[id]/cancelled-items", () => {
  it("devuelve los platos cancelados del comercio activo con nombre o correo", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.currency).toBe("COP");
    expect(body.items.map((row: { id: string; kind: string }) => [row.id, row.kind])).toEqual([
      ["i2", "round"],
      ["i1", "cancel"],
    ]);
    expect(body.items[0].actor).toEqual({ type: "email", email: "cocina@demo.test" });
    expect(body.items[1].actor).toEqual({ type: "staff", name: "Camila", email: "camila@demo.test" });

    // La cuenta se busca SIEMPRE dentro del comercio activo…
    expect(m.orderFindFirst).toHaveBeenCalledTimes(1);
    expect(m.orderFindFirst.mock.calls[0][0].where).toEqual({ id: "order-1", restaurantId: "rest-1" });
    // …y los nombres, con una sola consulta al personal de ese comercio.
    expect(m.userFindMany).toHaveBeenCalledTimes(1);
    expect(m.userFindMany.mock.calls[0][0].where).toEqual({
      restaurantId: "rest-1",
      email: { in: ["camila@demo.test", "cocina@demo.test"] },
    });
  });

  it("una cuenta de otro comercio responde como inexistente", async () => {
    m.orderFindFirst.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(404);
    expect(m.userFindMany).not.toHaveBeenCalled();
  });

  it("sin cancelaciones no consulta el personal", async () => {
    m.orderFindFirst.mockResolvedValue({ restaurant: { country: "CO" }, rounds: [], items: [] });
    const res = await call();
    expect(await res.json()).toEqual({ currency: "COP", items: [] });
    expect(m.userFindMany).not.toHaveBeenCalled();
  });

  it.each([null, { user: { role: "customer" } }])("rechaza a quien no es del personal (%j)", async (session) => {
    m.auth.mockResolvedValue(session);
    const res = await call();
    expect(res.status).toBe(401);
    expect(m.orderFindFirst).not.toHaveBeenCalled();
  });

  it("sin comercio activo no consulta nada", async () => {
    m.active.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(403);
    expect(m.orderFindFirst).not.toHaveBeenCalled();
  });
});
