// El personal busca por documento al pedir la factura personalizada y recibe
// el registro COMPLETO, sólo de su comercio (de la sesión, nunca del cuerpo)
// y sólo con los roles que ven Clientes. Datos inventados.
import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ auth: vi.fn(), active: vi.fn(), rate: vi.fn(), find: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/activeRestaurant", () => ({ getActiveRestaurantId: m.active }));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/lib/rateLimit", () => ({ rateLimit: m.rate }));
vi.mock("@/lib/invoiceCustomerMemoryQueries", () => ({ findSavedCustomer: m.find }));

import { POST } from "./route";

const row = {
  id: "cust-1",
  restaurantId: "rest-1",
  customerName: "Juana Gómez Ruiz",
  docType: "CC",
  docNumber: "1020304050",
  verificationDigit: null,
  email: "juana.gomez@gmail.com",
  ccEmails: ["conta@empresa.test"],
  phone: null,
  address: null,
  municipalityCode: null,
  city: null,
  department: null,
  country: "CO",
  creditEnabled: true,
  creditLimitCents: null,
  creditTermsDays: 30,
  discountEnabled: false,
  discountBps: 0,
  selfService: false,
  rememberOptOutAt: null,
  updatedAt: new Date(),
  _count: { voucherBatches: 0, voucherStatements: 0, creditCharges: 0, creditPayments: 0 },
};

const post = (body: unknown) =>
  POST(new Request("http://localhost/api/operator/billing-customers/lookup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

beforeEach(() => {
  vi.resetAllMocks();
  m.auth.mockResolvedValue({ user: { id: "user-1", role: "mesero" } });
  m.active.mockResolvedValue("rest-1");
  m.rate.mockResolvedValue(true);
  m.find.mockResolvedValue(row);
});

it("el personal autocompleta con los datos completos (y los correos adicionales)", async () => {
  const res = await post({ docType: "CC", docNumber: "1.020.304.050", restaurantId: "foreign" });
  expect(res.status).toBe(200);
  const { customer } = await res.json();
  expect(customer).toMatchObject({ id: "cust-1", customerName: "Juana Gómez Ruiz", email: "juana.gomez@gmail.com", ccEmails: ["conta@empresa.test"], creditEnabled: true });
  expect(customer).not.toHaveProperty("_count");
  expect(customer).not.toHaveProperty("selfService");
  // El comercio sale de la sesión.
  expect(m.find).toHaveBeenCalledWith("rest-1", "CC", "1020304050");
});

it("no encontrado → customer null", async () => {
  m.find.mockResolvedValue(null);
  expect(await (await post({ docType: "CC", docNumber: "1020304050" })).json()).toEqual({ customer: null });
});

it.each(["kitchen", "bar", "terminal", "customer"])("el rol %s no ve Clientes: 401", async (role) => {
  m.auth.mockResolvedValue({ user: { id: "user-1", role } });
  expect((await post({ docType: "CC", docNumber: "1020304050" })).status).toBe(401);
  expect(m.find).not.toHaveBeenCalled();
});
