// Paso "Cliente" del cobro: asocia la cuenta al cliente, aplica su
// descuento y devuelve la deuda de crédito para la pantalla.
import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  active: vi.fn(),
  orderFindFirst: vi.fn(),
  customerFindFirst: vi.fn(),
  applyDiscount: vi.fn(),
  summary: vi.fn(),
  publish: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/activeRestaurant", () => ({ getActiveRestaurantId: m.active }));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/lib/events", () => ({ publishOrderEvent: m.publish }));
vi.mock("@/lib/customerDiscount", () => ({ applyCustomerDiscount: m.applyDiscount }));
vi.mock("@/lib/customerCredit", () => ({ loadCustomerCreditSummary: m.summary }));
vi.mock("@/lib/db", () => ({
  db: {
    order: { findFirst: m.orderFindFirst },
    billingCustomer: { findFirst: m.customerFindFirst },
    $transaction: async (fn: (tx: unknown) => unknown) => fn({ tx: true }),
  },
}));

import { POST } from "./route";

const call = (body: unknown = { billingCustomerId: "cust-1" }) =>
  POST(
    new Request("http://localhost/api/operator/orders/order-1/customer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "order-1" }) },
  );

const customer = {
  id: "cust-1",
  customerName: "ACME",
  docType: "NIT",
  docNumber: "901944469",
  verificationDigit: "1",
  creditEnabled: true,
  creditLimitCents: 500_000,
  creditTermsDays: 30,
  discountEnabled: true,
  discountBps: 1000,
};

beforeEach(() => {
  vi.clearAllMocks();
  m.auth.mockResolvedValue({ user: { id: "user-1", role: "mesero" } });
  m.active.mockResolvedValue("r1");
  m.orderFindFirst.mockResolvedValue({ id: "order-1" });
  m.customerFindFirst.mockResolvedValue(customer);
  m.applyDiscount.mockResolvedValue({ applied: true, changed: true, discountPct: 10, discountCents: 10_000, subtotalCents: 100_000 });
  m.summary.mockResolvedValue({ debtCents: 120_000 });
});

it("aplica el descuento del cliente dentro de una transacción y devuelve el cliente con su deuda", async () => {
  const res = await call();
  expect(res.status).toBe(200);
  expect(m.applyDiscount).toHaveBeenCalledWith({ tx: true }, "order-1", "r1", customer);
  expect(m.publish).toHaveBeenCalledWith("r1", { type: "order.updated", orderId: "order-1" });
  expect(await res.json()).toEqual({
    ok: true,
    customer: { ...customer, debtCents: 120_000 },
    discount: { applied: true, changed: true, discountPct: 10, discountCents: 10_000, subtotalCents: 100_000 },
  });
});

it("si el descuento no cambió nada no avisa a las vistas", async () => {
  m.applyDiscount.mockResolvedValue({ applied: false, reason: "no_discount", discountPct: null, discountCents: 0, subtotalCents: 100_000 });
  await call();
  expect(m.publish).not.toHaveBeenCalled();
});

it("la cuenta y el cliente tienen que ser del comercio activo", async () => {
  m.customerFindFirst.mockResolvedValue(null);
  expect((await call()).status).toBe(404);
  m.orderFindFirst.mockResolvedValue(null);
  expect((await call()).status).toBe(404);
  expect(m.applyDiscount).not.toHaveBeenCalled();
});

it("sin sesión de staff es 403", async () => {
  m.auth.mockResolvedValue({ user: { id: "d", role: "customer" } });
  expect((await call()).status).toBe(403);
});
