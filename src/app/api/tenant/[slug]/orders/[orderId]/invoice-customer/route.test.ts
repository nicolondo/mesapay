// Búsqueda del comensal por documento: encontrado → sólo datos enmascarados
// y un token; no encontrado → misma forma, mismo estado y mismo tiempo
// mínimo; límites por orden, sesión e IP; aislada por comercio; nunca en
// los logs. Datos inventados.
import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  restaurant: vi.fn(),
  order: vi.fn(),
  rate: vi.fn(),
  find: vi.fn(),
  token: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/lib/db", () => ({
  db: { restaurant: { findUnique: m.restaurant }, order: { findFirst: m.order } },
}));
vi.mock("@/lib/rateLimit", () => ({ rateLimit: m.rate }));
vi.mock("@/lib/invoiceCustomerMemoryQueries", () => ({
  findSavedCustomer: m.find,
  createLookupToken: m.token,
}));

import { POST } from "./route";
import { LOOKUP_MIN_RESPONSE_MS } from "@/lib/invoiceCustomerMemory";

const saved = {
  id: "cust-secret-id",
  customerName: "Juana Gómez Ruiz",
  email: "juana.gomez@gmail.com",
  phone: "3001234567",
  ccEmails: ["conta@empresa.test"],
};

function post(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new Request("http://localhost/api/tenant/casa/orders/order-1/invoice-customer", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-real-ip": "203.0.113.7",
        cookie: "mesapay_guest_table-1=guest-scope; other=1",
        ...headers,
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ slug: "casa", orderId: "order-1" }) },
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  m.restaurant.mockResolvedValue({ id: "rest-1", name: "Casa de prueba" });
  m.order.mockResolvedValue({ status: "served", paidAt: null, simpleInvoice: null, invoiceRequests: [] });
  m.rate.mockResolvedValue(true);
  m.find.mockResolvedValue(null);
  m.token.mockResolvedValue("nonce.signature");
});

it("encontrado: sólo nombre y correo enmascarados y un token; nunca el id ni los datos completos", async () => {
  m.find.mockResolvedValue(saved);
  const res = await post({ docType: "CC", docNumber: "1.020.304.050" });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({
    restaurantName: "Casa de prueba",
    match: { token: "nonce.signature", name: "Ju••• G. R.", email: "ju***@gm***.com" },
  });
  const text = JSON.stringify(body);
  for (const secret of ["cust-secret-id", "Juana", "juana.gomez@gmail.com", "3001234567", "conta@empresa.test"]) {
    expect(text).not.toContain(secret);
  }
  // Busca normalizado, en ESTE comercio y sin los que pidieron no recordarse.
  expect(m.find).toHaveBeenCalledWith("rest-1", "CC", "1020304050", { forDiner: true });
  expect(m.token).toHaveBeenCalledWith("rest-1", "order-1", "cust-secret-id");
});

it("no encontrado: misma forma y mismo estado", async () => {
  const res = await post({ docType: "CC", docNumber: "1020304050" });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ restaurantName: "Casa de prueba", match: null });
  expect(m.token).not.toHaveBeenCalled();
});

it("encontrado o no, tarda al menos lo mismo", async () => {
  for (const found of [null, saved]) {
    m.find.mockResolvedValue(found);
    const started = Date.now();
    await post({ docType: "CC", docNumber: "1020304050" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(LOOKUP_MIN_RESPONSE_MS - 5);
  }
});

it("límite de intentos por orden, por sesión y por IP: 429 sin consultar nada", async () => {
  m.rate.mockImplementation(async (key: string) => !key.startsWith("invoice-customer:session:"));
  const res = await post({ docType: "CC", docNumber: "1020304050" });
  expect(res.status).toBe(429);
  expect(await res.json()).toEqual({ error: "rate_limited" });
  expect(m.find).not.toHaveBeenCalled();
  const keys = m.rate.mock.calls.map((c) => c[0] as string);
  expect(keys).toEqual([
    "invoice-customer:order:order-1",
    expect.stringMatching(/^invoice-customer:session:rest-1:[0-9a-f]{64}$/),
    "invoice-customer:ip:rest-1:203.0.113.7",
  ]);
  // Ninguna clave lleva el documento.
  expect(keys.join(" ")).not.toContain("1020304050");
});

it("sólo dentro de una orden viva del comercio", async () => {
  m.order.mockResolvedValue(null);
  expect((await post({ docType: "CC", docNumber: "1020304050" })).status).toBe(404);
  m.order.mockResolvedValue({ status: "cancelled", paidAt: null, simpleInvoice: null, invoiceRequests: [] });
  expect((await post({ docType: "CC", docNumber: "1020304050" })).status).toBe(409);
  m.order.mockResolvedValue({ status: "served", paidAt: null, simpleInvoice: null, invoiceRequests: [{ id: "req-1" }] });
  expect((await post({ docType: "CC", docNumber: "1020304050" })).status).toBe(409);
  // Facturada antes de cobrar: el adquiriente ya está en la factura.
  m.order.mockResolvedValue({ status: "served", paidAt: null, simpleInvoice: { id: "inv-1" }, invoiceRequests: [] });
  expect((await post({ docType: "CC", docNumber: "1020304050" })).status).toBe(409);
  expect(m.order).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "order-1", restaurantId: "rest-1" } }));
  expect(m.find).not.toHaveBeenCalled();
});

it("documento inválido: 400 con su código, sin gastar intentos ni consultar", async () => {
  const res = await post({ docType: "NIT", docNumber: "901944469-2" });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "invalid", code: "invalid_verification_digit" });
  expect(m.rate).not.toHaveBeenCalled();
  expect(m.find).not.toHaveBeenCalled();
});

it("nunca escribe la cédula en los logs", async () => {
  const spies = (["log", "warn", "error", "info"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => undefined));
  m.find.mockResolvedValue(saved);
  await post({ docType: "CC", docNumber: "1020304050" });
  m.find.mockResolvedValue(null);
  await post({ docType: "CC", docNumber: "1020304050" });
  for (const spy of spies) {
    expect(JSON.stringify(spy.mock.calls)).not.toContain("1020304050");
    spy.mockRestore();
  }
});
