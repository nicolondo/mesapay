// La solicitud de factura nominativa ya no pide dirección, ciudad ni
// departamento: el payload sólo trae identidad y correo, y la fila queda
// con esos tres campos en null. Si un cliente viejo los manda, se guardan.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  restaurant: vi.fn(),
  order: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  publish: vi.fn(),
  issue: vi.fn(),
  deliver: vi.fn(),
  staff: vi.fn(),
  customer: vi.fn(),
  applyDiscount: vi.fn(),
  remember: vi.fn(),
  consume: vi.fn(),
  auditUse: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/lib/db", () => ({
  db: {
    restaurant: { findUnique: m.restaurant },
    order: { findUnique: m.order },
    invoiceRequest: { findFirst: m.findFirst, create: m.create, update: m.update },
    billingCustomer: { findFirst: m.customer },
    $transaction: async (fn: (tx: unknown) => unknown) => fn({ tx: true }),
  },
}));
vi.mock("@/lib/events", () => ({ publishOrderEvent: m.publish }));
vi.mock("@/lib/simpleInvoice", () => ({ issueSimpleInvoice: m.issue }));
vi.mock("@/lib/invoiceDelivery", () => ({ deliverInvoiceEmail: m.deliver }));
// staffAccess arrastra @/auth (next-auth), que no carga en el entorno node
// de vitest: se mockea sin importOriginal.
vi.mock("@/lib/staffAccess", () => ({
  staffForRestaurant: m.staff,
  COLLECTOR_ROLES: ["operator", "platform_admin", "group_admin", "mesero", "terminal"],
}));
vi.mock("@/lib/customerDiscount", () => ({ applyCustomerDiscount: m.applyDiscount }));
// La memoria de clientes toca la DB y la auditoría (que arrastra next-auth):
// acá sólo importa QUÉ le pide la ruta. Sus reglas tienen tests propios.
vi.mock("@/lib/invoiceCustomerMemoryQueries", () => ({
  rememberInvoiceCustomer: m.remember,
  consumeLookupToken: m.consume,
  auditSavedCustomerUse: m.auditUse,
}));

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
  m.staff.mockResolvedValue(null);
  m.customer.mockResolvedValue(null);
  m.remember.mockResolvedValue({ kind: "none", reason: "not_remembered" });
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

it("ligada a un cliente de facturación por el staff, aplica su descuento comercial", async () => {
  m.staff.mockResolvedValue({ user: { id: "user-1", role: "mesero" } });
  m.customer.mockResolvedValue({ discountEnabled: true, discountBps: 1000 });
  m.applyDiscount.mockResolvedValue({ applied: true, changed: true, discountPct: 10, discountCents: 5_000, subtotalCents: 50_000 });
  const res = await post({ ...payload, billingCustomerId: "cust-1" });
  expect(res.status).toBe(200);
  expect(m.customer).toHaveBeenCalledWith({
    where: { id: "cust-1", restaurantId: "rest-1" },
    select: { discountEnabled: true, discountBps: true },
  });
  expect(m.applyDiscount).toHaveBeenCalledWith({ tx: true }, "order-1", "rest-1", { discountEnabled: true, discountBps: 1000 });
  expect((await res.json()).discount).toMatchObject({ applied: true, discountCents: 5_000 });
  // La solicitud se guarda igual, sin el id del cliente (no es columna suya).
  expect(m.create).toHaveBeenCalledWith({ data: expect.not.objectContaining({ billingCustomerId: "cust-1" }) });
});

it("sin sesión de staff el billingCustomerId se ignora: el comensal no puede darse descuentos", async () => {
  const res = await post({ ...payload, billingCustomerId: "cust-1" });
  expect(res.status).toBe(200);
  expect(m.customer).not.toHaveBeenCalled();
  expect(m.applyDiscount).not.toHaveBeenCalled();
  expect((await res.json()).discount).toBeNull();
});

it("factura ya emitida ANTES de cobrar: el adquiriente no cambia (409 order_invoiced; se corrige con nota crédito)", async () => {
  m.order.mockResolvedValue({
    id: "order-1",
    restaurantId: "rest-1",
    status: "served",
    simpleInvoice: { id: "inv-1", invoiceNumber: 6490, snapshot: { invoicePrefix: "FESM" } },
  });
  const res = await post(payload);
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({
    error: "order_invoiced",
    invoice: { invoiceId: "inv-1", documentNumber: "FESM6490" },
  });
  expect(m.create).not.toHaveBeenCalled();
  expect(m.update).not.toHaveBeenCalled();
  expect(m.issue).not.toHaveBeenCalled();
});

it("con la cuenta ya pagada sigue el camino de siempre (la solicitud tardía se guarda)", async () => {
  m.order.mockResolvedValue({
    id: "order-1",
    restaurantId: "rest-1",
    status: "paid",
    simpleInvoice: { id: "inv-1", invoiceNumber: 6490, snapshot: { invoicePrefix: "FESM" } },
  });
  m.issue.mockResolvedValue({
    ok: true,
    invoiceId: "inv-1",
    invoiceUrl: "u",
    invoiceNumber: 6490,
    snapshot: {},
    email: null,
    locale: null,
    alreadyIssued: true,
  });
  const res = await post(payload);
  expect(res.status).toBe(200);
  expect(m.create).toHaveBeenCalled();
});


// ── "Recordar mis datos" ─────────────────────────────────────────────

// Un cliente guardado, con beneficios: el comensal que lo usa no recibe
// ninguno, ni sus datos completos.
const savedCustomer = {
  id: "cust-9",
  restaurantId: "rest-1",
  customerName: "Juana Gómez Ruiz",
  docType: "CC",
  docNumber: "1020304050",
  verificationDigit: null,
  email: "juana.gomez@gmail.com",
  ccEmails: ["contabilidad@empresa.test"],
  phone: null,
  address: null,
  municipalityCode: null,
  city: null,
  department: null,
  country: "CO",
  creditEnabled: true,
  creditLimitCents: null,
  creditTermsDays: 30,
  discountEnabled: true,
  discountBps: 2000,
  selfService: false,
  rememberOptOutAt: null,
  updatedAt: new Date(),
  _count: { voucherBatches: 0, voucherStatements: 0, creditCharges: 1, creditPayments: 0 },
};

it("sin la casilla (cliente viejo) no se recuerda nada: rememberCustomer ausente = false", async () => {
  const res = await post(payload);
  expect(res.status).toBe(200);
  expect(m.create).toHaveBeenCalledWith({ data: expect.objectContaining({ rememberCustomer: false, fromSavedCustomer: false }) });
  expect(m.remember).toHaveBeenCalledWith(expect.objectContaining({ actor: "diner", remember: false, ccEmailsProvided: false }));
});

it("con la casilla marcada, el comensal pide recordar sus datos (actor diner)", async () => {
  const res = await post({ ...payload, rememberCustomer: true });
  expect(res.status).toBe(200);
  expect(m.create).toHaveBeenCalledWith({ data: expect.objectContaining({ rememberCustomer: true }) });
  expect(m.remember).toHaveBeenCalledWith({
    restaurantId: "rest-1",
    orderId: "order-1",
    actor: "diner",
    remember: true,
    ccEmailsProvided: false,
    fields: expect.objectContaining({ docType: "CC", docNumber: "1020304050", email: "ana@correo.com", ccEmails: [] }),
  });
});

it.each([
  ["operator", "manager"],
  ["group_admin", "manager"],
  ["mesero", "assistant"],
  ["terminal", "assistant"],
])("con sesión %s la memoria actúa como %s", async (role, actor) => {
  m.staff.mockResolvedValue({ user: { id: "user-1", role } });
  await post({ ...payload, rememberCustomer: true, ccEmails: [] });
  expect(m.remember).toHaveBeenCalledWith(expect.objectContaining({ actor, ccEmailsProvided: true }));
});

it("varios correos: se guardan normalizados en la solicitud y van en copia del comprobante", async () => {
  m.staff.mockResolvedValue({ user: { id: "user-1", role: "operator" } });
  m.issue.mockResolvedValue({ ok: true, invoiceId: "inv-1", invoiceUrl: "u", invoiceNumber: 1, snapshot: {}, email: "ana@correo.com", locale: null, alreadyIssued: false });
  const res = await post({ ...payload, ccEmails: ["Conta@Empresa.test", "", "ana@correo.com", "conta@empresa.test", "gerencia@empresa.test"] });
  expect(res.status).toBe(200);
  expect(m.create).toHaveBeenCalledWith({ data: expect.objectContaining({ ccEmails: ["conta@empresa.test", "gerencia@empresa.test"] }) });
  expect(m.deliver).toHaveBeenCalledWith(expect.objectContaining({
    invoice: expect.objectContaining({ email: "ana@correo.com", cc: ["conta@empresa.test", "gerencia@empresa.test"] }),
  }));
});

it("un correo adicional inválido o más de 5 en total se rechazan con su código", async () => {
  const bad = await post({ ...payload, ccEmails: ["ok@empresa.test", "no-es-correo"] });
  expect(bad.status).toBe(400);
  expect(await bad.json()).toMatchObject({ error: "invalid", code: "invalid_email", index: 1 });
  const many = await post({ ...payload, ccEmails: ["a@e.test", "b@e.test", "c@e.test", "d@e.test", "e@e.test"] });
  expect(many.status).toBe(400);
  expect(await many.json()).toMatchObject({ error: "invalid", code: "too_many_emails" });
  expect(m.create).not.toHaveBeenCalled();
});

describe("Usar estos datos (token del comensal)", () => {
  const usePayload = { savedCustomerToken: "nonce1234567890.signature", docType: "CC", docNumber: "1.020.304.050" };

  it("arma la solicitud con el registro guardado y NO aplica crédito, descuento ni beneficios", async () => {
    m.consume.mockResolvedValue({ ok: true, customer: savedCustomer });
    const res = await post({ ...usePayload, billingCustomerId: "cust-9" });
    expect(res.status).toBe(200);
    expect(m.consume).toHaveBeenCalledWith("nonce1234567890.signature", "rest-1", "order-1");
    expect(m.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        customerName: "Juana Gómez Ruiz",
        docNumber: "1020304050",
        email: "juana.gomez@gmail.com",
        ccEmails: ["contabilidad@empresa.test"],
        fromSavedCustomer: true,
        rememberCustomer: null,
      }),
    });
    expect(m.applyDiscount).not.toHaveBeenCalled();
    expect(m.customer).not.toHaveBeenCalled();
    expect(m.remember).not.toHaveBeenCalled();
    expect(m.auditUse).toHaveBeenCalledWith("rest-1", "order-1", "cust-9", "diner");
  });

  it("al comensal le responde enmascarado y sin el enlace de la factura", async () => {
    m.consume.mockResolvedValue({ ok: true, customer: savedCustomer });
    m.issue.mockResolvedValue({ ok: true, invoiceId: "inv-1", invoiceUrl: "https://mesapay.co/factura/inv-1", invoiceNumber: 1, snapshot: {}, email: "juana.gomez@gmail.com", locale: null, alreadyIssued: false });
    const res = await post(usePayload);
    const body = await res.json();
    const text = JSON.stringify(body);
    expect(text).not.toContain("Juana Gómez Ruiz");
    expect(text).not.toContain("juana.gomez@gmail.com");
    expect(text).not.toContain("contabilidad@empresa.test");
    expect(text).not.toContain("cust-9");
    expect(body).toMatchObject({
      invoiceUrl: null,
      sentToSaved: true,
      request: { customerName: "Ju••• G. R.", email: "ju***@gm***.com", docNumber: "1020304050", masked: true },
    });
    // El correo sí sale al dueño de los datos, con sus adicionales.
    expect(m.deliver).toHaveBeenCalledWith(expect.objectContaining({
      invoice: expect.objectContaining({ email: "juana.gomez@gmail.com", cc: ["contabilidad@empresa.test"] }),
    }));
  });

  it("token vencido, ya usado o de otra orden: 409 y no se guarda nada", async () => {
    m.consume.mockResolvedValue({ ok: false, error: "saved_customer_expired" });
    const res = await post(usePayload);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "saved_customer_expired" });
    expect(m.create).not.toHaveBeenCalled();
    expect(m.issue).not.toHaveBeenCalled();
  });

  it("el registro guardado se valida igual que uno escrito: inválido ⇒ 409 y se piden los datos", async () => {
    m.consume.mockResolvedValue({ ok: true, customer: { ...savedCustomer, email: "sin-arroba" } });
    const res = await post(usePayload);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "saved_customer_invalid" });
    expect(m.create).not.toHaveBeenCalled();
  });

  it("el documento escrito tiene que ser el del registro", async () => {
    m.consume.mockResolvedValue({ ok: true, customer: savedCustomer });
    const res = await post({ ...usePayload, docNumber: "999999999" });
    expect(res.status).toBe(409);
    expect(m.create).not.toHaveBeenCalled();
  });

  it("con sesión de personal la respuesta no se enmascara", async () => {
    m.staff.mockResolvedValue({ user: { id: "user-1", role: "operator" } });
    m.consume.mockResolvedValue({ ok: true, customer: savedCustomer });
    const res = await post(usePayload);
    expect(m.create).toHaveBeenCalledWith({ data: expect.objectContaining({ fromSavedCustomer: false }) });
    expect((await res.json()).request).toMatchObject({ customerName: "Juana Gómez Ruiz" });
  });
});
