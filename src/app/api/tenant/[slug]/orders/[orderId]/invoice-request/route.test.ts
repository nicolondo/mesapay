// La solicitud de factura nominativa ya no pide dirección, ciudad ni
// departamento: el payload sólo trae identidad y correo, y la fila queda
// con esos tres campos en null. Si un cliente viejo los manda, se guardan.
import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  restaurant: vi.fn(),
  order: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  publish: vi.fn(),
  issue: vi.fn(),
  deliver: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/lib/db", () => ({
  db: {
    restaurant: { findUnique: m.restaurant },
    order: { findUnique: m.order },
    invoiceRequest: { findFirst: m.findFirst, create: m.create, update: m.update },
  },
}));
vi.mock("@/lib/events", () => ({ publishOrderEvent: m.publish }));
vi.mock("@/lib/simpleInvoice", () => ({ issueSimpleInvoice: m.issue }));
vi.mock("@/lib/invoiceDelivery", () => ({ deliverInvoiceEmail: m.deliver }));

import { POST } from "./route";

const payload = {
  customerName: "Ana Pérez",
  docType: "CC",
  docNumber: "1020304050",
  email: "ana@correo.com",
};
const withAddress = { ...payload, address: "Calle 1 # 2-3", city: "Envigado", department: "Antioquia" };

function post(body: unknown) {
  return POST(
    new Request("http://localhost/api/tenant/son-y-melona/orders/order-1/invoice-request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ slug: "son-y-melona", orderId: "order-1" }) },
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  m.restaurant.mockResolvedValue({ id: "rest-1", enabledModules: ["einvoicing"] });
  m.order.mockResolvedValue({ id: "order-1", restaurantId: "rest-1" });
  m.findFirst.mockResolvedValue(null);
  m.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "req-1", ...data }));
  m.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "req-1", ...data }));
  // La orden todavía no está paga: la factura sale al confirmarse el cobro.
  m.issue.mockResolvedValue({ ok: false, error: "order_not_paid" });
});

it("registra la solicitud sólo con documento, nombre y correo (sin dirección)", async () => {
  const res = await post(payload);
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, deferred: true, replaced: false });
  expect(m.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      restaurantId: "rest-1",
      orderId: "order-1",
      customerName: "Ana Pérez",
      docType: "CC",
      docNumber: "1020304050",
      email: "ana@correo.com",
      address: null,
      city: null,
      department: null,
      placeId: null,
    }),
  });
  // La tirilla nominativa recibe el cliente sin dirección.
  expect(m.issue).toHaveBeenCalledWith(
    expect.objectContaining({
      customer: { name: "Ana Pérez", docType: "CC", docNumber: "1020304050", address: null, city: null, department: null },
    }),
  );
  expect(m.publish).toHaveBeenCalledWith("rest-1", { type: "order.updated", orderId: "order-1" });
});

it.each([
  { address: "", city: "", department: "" },
  { address: null, city: null, department: null },
])("trata dirección vacía o null como ausente: %j", async (extra) => {
  const res = await post({ ...payload, ...extra });
  expect(res.status).toBe(200);
  expect(m.create).toHaveBeenCalledWith({
    data: expect.objectContaining({ address: null, city: null, department: null }),
  });
});

it("sigue guardando la dirección si un cliente viejo la manda", async () => {
  const res = await post(withAddress);
  expect(res.status).toBe(200);
  expect(m.create).toHaveBeenCalledWith({
    data: expect.objectContaining({ address: "Calle 1 # 2-3", city: "Envigado", department: "Antioquia" }),
  });
});

it("sobrescribe la solicitud pendiente de la misma cuenta sin exigir dirección", async () => {
  m.findFirst.mockResolvedValueOnce({ id: "req-0", status: "pending" });
  const res = await post({ ...payload, docNumber: "1020304051" });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, replaced: true });
  expect(m.update).toHaveBeenCalledWith({
    where: { id: "req-0" },
    data: expect.objectContaining({ docNumber: "1020304051", address: null, city: null, department: null }),
  });
  expect(m.create).not.toHaveBeenCalled();
});

// La identificación se captura SIN dígito de verificación: el número queda
// solo (la DIAN recibe el DV calculado en `customerPartyFor`) y, si el
// comensal igual lo escribe, se separa; uno que no corresponde se rechaza con
// un código que el formulario traduce.
it.each(["901944469", "901.944.469", "901944469-1", "901.944.469-1"])("NIT %s: guarda y factura el número sin DV", async (docNumber) => {
  const res = await post({ ...payload, docType: "NIT", docNumber, customerName: "ACME S.A.S." });
  expect(res.status).toBe(200);
  expect(m.create).toHaveBeenCalledWith({
    data: expect.objectContaining({ docType: "NIT", docNumber: "901944469" }),
  });
  expect(m.issue).toHaveBeenCalledWith(
    expect.objectContaining({ customer: expect.objectContaining({ docType: "NIT", docNumber: "901944469" }) }),
  );
  // El resumen que vuelve al formulario ya viene normalizado.
  expect(await res.json()).toMatchObject({ request: expect.objectContaining({ docNumber: "901944469" }) });
});

it("una cédula se guarda sin puntos", async () => {
  const res = await post({ ...payload, docNumber: "1.020.304.050" });
  expect(res.status).toBe(200);
  expect(m.create).toHaveBeenCalledWith({ data: expect.objectContaining({ docNumber: "1020304050" }) });
});

it("un DV que no corresponde al NIT se rechaza con su código", async () => {
  const res = await post({ ...payload, docType: "NIT", docNumber: "901944469-2" });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ error: "invalid", code: "invalid_verification_digit" });
  expect(m.create).not.toHaveBeenCalled();
});

it.each([
  { docType: "NIT", docNumber: "12ABC34" },
  { docType: "CC", docNumber: "AB123456" },
  { docType: "CC", docNumber: "1020304050-1" },
])("un documento con forma inválida se rechaza con su código: %j", async (extra) => {
  const res = await post({ ...payload, ...extra });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ error: "invalid", code: "invalid_document" });
  expect(m.create).not.toHaveBeenCalled();
});

it.each([
  { customerName: "A" },
  { docNumber: "12" },
  { email: "sin-arroba" },
  { address: "x" },
])("rechaza con 400 lo que sí sigue siendo inválido: %j", async (extra) => {
  const res = await post({ ...payload, ...extra });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ error: "invalid" });
  expect(m.create).not.toHaveBeenCalled();
  expect(m.issue).not.toHaveBeenCalled();
});
