// La puerta de la redención: canal por sesión (staff vs. comensal), el
// control de caja del mesero, y los códigos de error como HTTP.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  restaurantFindUnique: vi.fn(),
  staff: vi.fn(),
  rate: vi.fn(),
  redeem: vi.fn(),
  preview: vi.fn(),
}));

vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/lib/db", () => ({ db: { restaurant: { findUnique: m.restaurantFindUnique } } }));
vi.mock("@/lib/rateLimit", () => ({ rateLimit: m.rate }));
// Sin importOriginal: staffAccess arrastra @/auth (next-auth), que no
// carga en el entorno node de vitest.
vi.mock("@/lib/staffAccess", () => ({
  staffForRestaurant: m.staff,
  COLLECTOR_ROLES: ["operator", "platform_admin", "group_admin", "mesero", "terminal"],
}));
vi.mock("@/lib/vouchers/redeem", () => ({ redeemVoucher: m.redeem, previewVoucher: m.preview }));

import { POST } from "./route";
import { POST as LOOKUP } from "../lookup/route";

const call = (handler: typeof POST, body: unknown = { orderId: "order-1", code: "SM-7K3Q-9X2A" }) =>
  handler(
    new Request("http://localhost/api/tenant/son-y-melona/vouchers/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ slug: "son-y-melona" }) },
  ) as Promise<Response>;

beforeEach(() => {
  vi.resetAllMocks();
  m.restaurantFindUnique.mockResolvedValue({ id: "rest-1", adminOnlyCharge: false });
  m.staff.mockResolvedValue(null);
  m.rate.mockResolvedValue(true);
  m.redeem.mockResolvedValue({ ok: true, code: "SM-7K3Q-9X2A", paymentId: "pay-1", amountCents: 100, balanceAfterCents: 0, outstandingAfterCents: 0, fullyPaid: true, alreadyApplied: false });
  m.preview.mockResolvedValue({ ok: true, code: "SM-7K3Q-9X2A", balanceCents: 100, applicableCents: 100, outstandingCents: 100 });
});

describe("canal", () => {
  it("sin sesión de staff redime como comensal", async () => {
    const res = await call(POST);
    expect(res.status).toBe(200);
    expect(m.redeem).toHaveBeenCalledWith({
      restaurantId: "rest-1",
      code: "SM-7K3Q-9X2A",
      orderId: "order-1",
      channel: "diner",
      userId: null,
    });
  });
  it("con sesión de staff del comercio redime como staff con su usuario", async () => {
    m.staff.mockResolvedValue({ user: { id: "user-9", role: "mesero" } });
    await call(POST);
    expect(m.redeem).toHaveBeenCalledWith(expect.objectContaining({ channel: "staff", userId: "user-9" }));
  });
  it("control de caja: el mesero no aplica bonos si sólo el administrador cobra; el comensal sí", async () => {
    m.restaurantFindUnique.mockResolvedValue({ id: "rest-1", adminOnlyCharge: true });
    m.staff.mockResolvedValue({ user: { id: "user-9", role: "mesero" } });
    const res = await call(POST);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "charge_admin_only" });
    expect(m.redeem).not.toHaveBeenCalled();
    m.staff.mockResolvedValue(null);
    expect((await call(POST)).status).toBe(200);
  });
});

describe("errores como HTTP", () => {
  it.each([
    ["module_disabled", 403],
    ["not_found", 404],
    ["batch_unpaid", 409],
    ["expired", 409],
    ["exhausted", 409],
    ["order_closed", 409],
  ])("%s → %i", async (error, status) => {
    m.redeem.mockResolvedValue({ ok: false, error });
    const res = await call(POST);
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error });
  });
  it("payload inválido y comercio desconocido", async () => {
    expect((await call(POST, { orderId: "order-1" })).status).toBe(400);
    m.restaurantFindUnique.mockResolvedValue(null);
    expect((await call(POST)).status).toBe(404);
    expect(m.redeem).not.toHaveBeenCalled();
  });
  it("límite de intentos por cuenta", async () => {
    m.rate.mockResolvedValue(false);
    expect((await call(POST)).status).toBe(429);
    expect((await call(LOOKUP)).status).toBe(429);
    expect(m.redeem).not.toHaveBeenCalled();
    expect(m.preview).not.toHaveBeenCalled();
  });
});

describe("lookup", () => {
  it("devuelve el preview sin aplicar", async () => {
    const res = await call(LOOKUP);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, applicableCents: 100 });
    expect(m.preview).toHaveBeenCalledWith({ restaurantId: "rest-1", code: "SM-7K3Q-9X2A", orderId: "order-1" });
    expect(m.redeem).not.toHaveBeenCalled();
  });
  it("módulo apagado: 403", async () => {
    m.preview.mockResolvedValue({ ok: false, error: "module_disabled" });
    expect((await call(LOOKUP)).status).toBe(403);
  });
});
