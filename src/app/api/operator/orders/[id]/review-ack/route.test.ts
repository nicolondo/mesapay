// «Mantener» del aviso «Revisar»: deja constancia en la cuenta (reviewAckAt)
// sólo en cuentas vivas del comercio de la sesión.
import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ auth: vi.fn(), active: vi.fn(), updateMany: vi.fn(), publish: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/activeRestaurant", () => ({ getActiveRestaurantId: m.active }));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/lib/events", () => ({ publishOrderEvent: m.publish }));
vi.mock("@/lib/db", () => ({ db: { order: { updateMany: m.updateMany } } }));

import { POST } from "./route";

const call = () =>
  POST(new Request("http://localhost/api/operator/orders/o1/review-ack", { method: "POST" }), {
    params: Promise.resolve({ id: "o1" }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  m.auth.mockResolvedValue({ user: { id: "u1", role: "mesero" } });
  m.active.mockResolvedValue("r1");
  m.updateMany.mockResolvedValue({ count: 1 });
});

it("el mesero confirma «Mantener»: se guarda la hora y se avisa a las vistas", async () => {
  const res = await call();
  expect(res.status).toBe(200);
  expect(m.updateMany).toHaveBeenCalledWith({
    where: { id: "o1", restaurantId: "r1", status: { notIn: ["paid", "cancelled"] } },
    data: { reviewAckAt: expect.any(Date) },
  });
  expect(m.publish).toHaveBeenCalledWith("r1", { type: "order.updated", orderId: "o1" });
});

it("cuenta cerrada o de otro comercio: 409 sin avisar", async () => {
  m.updateMany.mockResolvedValue({ count: 0 });
  expect((await call()).status).toBe(409);
  expect(m.publish).not.toHaveBeenCalled();
});

it("el datáfono y el comensal no pueden", async () => {
  m.auth.mockResolvedValue({ user: { id: "t", role: "terminal" } });
  expect((await call()).status).toBe(403);
  m.auth.mockResolvedValue({ user: { id: "d", role: "customer" } });
  expect((await call()).status).toBe(403);
  expect(m.updateMany).not.toHaveBeenCalled();
});
