// Factura GENÉRICA (consumidor final) pedida por el comensal o el mesero.
// El dueño: "si no se pone ningún correo en lo de la factura electrónica
// genérica que igual se genere la factura para poderla imprimir". Lo que
// se blinda acá es que el correo sea opcional en los DOS caminos:
//   · sin pagar (checkout): se guarda la intención —vacía si no hay
//     correo— y responde `deferred`; `issueInvoiceOnPaid` la emite al
//     cobrar (ver invoiceOnPaid.test.ts).
//   · pagada: se emite en el momento y vuelve la URL para imprimirla.
// Con correo, todo sigue igual que antes.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  restaurantFindUnique: vi.fn(),
  orderUpdateMany: vi.fn(),
  invoiceUpdateMany: vi.fn(),
  transaction: vi.fn(),
  issueSimpleInvoice: vi.fn(),
  deliverInvoiceEmail: vi.fn(),
}));

vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/lib/db", () => ({
  db: {
    restaurant: { findUnique: m.restaurantFindUnique },
    order: { updateMany: m.orderUpdateMany },
    simpleInvoice: { updateMany: m.invoiceUpdateMany },
    $transaction: m.transaction,
  },
}));
vi.mock("@/lib/simpleInvoice", () => ({ issueSimpleInvoice: m.issueSimpleInvoice }));
vi.mock("@/lib/invoiceDelivery", () => ({ deliverInvoiceEmail: m.deliverInvoiceEmail }));

import { POST } from "./route";

const call = (body: unknown) =>
  POST(
    new Request("http://localhost/api/tenant/chucho/orders/order-1/simple-invoice", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ slug: "chucho", orderId: "order-1" }) },
  ) as Promise<Response>;

function issued(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    invoiceId: "inv-1",
    invoiceUrl: "https://mesapay.co/factura/inv-1",
    invoiceNumber: 7,
    snapshot: { restaurantName: "Donde Chucho" },
    email: null,
    locale: "es",
    alreadyIssued: false,
    ...over,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  m.restaurantFindUnique.mockResolvedValue({ id: "rest-1", enabledModules: [] });
  m.orderUpdateMany.mockResolvedValue({ count: 1 });
  m.invoiceUpdateMany.mockResolvedValue({ count: 1 });
  m.transaction.mockResolvedValue([]);
  m.issueSimpleInvoice.mockResolvedValue(issued());
  m.deliverInvoiceEmail.mockResolvedValue({ sent: "none", reason: "no_email" });
});

describe("SIN pagar (pedida en el checkout)", () => {
  beforeEach(() => {
    m.issueSimpleInvoice.mockResolvedValue({ ok: false, error: "order_not_paid" });
  });

  it("sin correo responde OK diferido y guarda la intención vacía (antes: 400 email_required)", async () => {
    for (const body of [{ email: "" }, { email: "   " }, {}]) {
      m.orderUpdateMany.mockClear();
      const res = await call(body);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, deferred: true });
      // "" = la pidieron sin correo: al cobrar se emite igual, para imprimir.
      expect(m.orderUpdateMany).toHaveBeenCalledWith({
        where: { id: "order-1", restaurantId: "rest-1" },
        data: { simpleInvoiceEmail: "" },
      });
    }
    expect(m.deliverInvoiceEmail).not.toHaveBeenCalled();
  });

  it("con correo guarda el correo, como antes", async () => {
    const res = await call({ email: "Ana@Correo.com" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deferred: true });
    expect(m.issueSimpleInvoice).toHaveBeenCalledWith({
      tenantId: "rest-1",
      orderId: "order-1",
      email: "ana@correo.com",
    });
    expect(m.orderUpdateMany).toHaveBeenCalledWith({
      where: { id: "order-1", restaurantId: "rest-1" },
      data: { simpleInvoiceEmail: "ana@correo.com" },
    });
    expect(m.deliverInvoiceEmail).not.toHaveBeenCalled();
  });

  it("la orden de otro comercio no se toca: 404", async () => {
    m.orderUpdateMany.mockResolvedValue({ count: 0 });
    const res = await call({ email: "" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});

describe("PAGADA", () => {
  it("sin correo emite la factura y devuelve la URL para imprimirla", async () => {
    const res = await call({ email: "" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      invoiceId: "inv-1",
      invoiceUrl: "https://mesapay.co/factura/inv-1",
    });
    expect(m.issueSimpleInvoice).toHaveBeenCalledWith({
      tenantId: "rest-1",
      orderId: "order-1",
      email: null,
    });
    // Queda la constancia de que la pidieron (sin pisar un correo previo),
    // para que la pantalla de "listo" muestre el botón de imprimir.
    expect(m.orderUpdateMany).toHaveBeenCalledWith({
      where: { id: "order-1", restaurantId: "rest-1", simpleInvoiceEmail: null },
      data: { simpleInvoiceEmail: "" },
    });
    // Se consulta al repartidor de correos, que sin destinatario no manda
    // nada (sale por `no_email`): no hay envío que falle ni que reintentar.
    expect(m.deliverInvoiceEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        invoice: expect.objectContaining({ email: null }),
        firstIssuance: true,
        emailJustProvided: false,
      }),
    );
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it("sin correo y ya emitida (p. ej. al cobrar): devuelve la misma para imprimir", async () => {
    m.issueSimpleInvoice.mockResolvedValue(issued({ alreadyIssued: true }));
    const res = await call({});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      alreadyIssued: true,
      invoiceId: "inv-1",
      invoiceUrl: "https://mesapay.co/factura/inv-1",
    });
    expect(m.deliverInvoiceEmail).toHaveBeenCalledWith(
      expect.objectContaining({ firstIssuance: false, emailJustProvided: false }),
    );
  });

  it("con correo emite y lo manda, como antes", async () => {
    m.issueSimpleInvoice.mockResolvedValue(issued({ email: "ana@correo.com" }));
    const res = await call({ email: "ana@correo.com" });
    expect(res.status).toBe(200);
    expect(m.issueSimpleInvoice).toHaveBeenCalledWith({
      tenantId: "rest-1",
      orderId: "order-1",
      email: "ana@correo.com",
    });
    expect(m.deliverInvoiceEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        invoice: expect.objectContaining({ email: "ana@correo.com" }),
        firstIssuance: true,
      }),
    );
  });

  it("con correo sobre una factura ya emitida sin correo: lo guarda y lo manda", async () => {
    m.issueSimpleInvoice.mockResolvedValue(issued({ alreadyIssued: true, email: null }));
    const res = await call({ email: "ana@correo.com" });
    expect(res.status).toBe(200);
    expect(m.transaction).toHaveBeenCalledTimes(1);
    expect(m.invoiceUpdateMany).toHaveBeenCalledWith({
      where: { id: "inv-1", email: null },
      data: { email: "ana@correo.com" },
    });
    expect(m.orderUpdateMany).toHaveBeenCalledWith({
      where: { id: "order-1", restaurantId: "rest-1" },
      data: { simpleInvoiceEmail: "ana@correo.com" },
    });
    expect(m.deliverInvoiceEmail).toHaveBeenCalledWith(
      expect.objectContaining({ emailJustProvided: true }),
    );
  });
});

describe("validación", () => {
  it("un correo inválido sigue siendo 400 invalid_email", async () => {
    const res = await call({ email: "ana@correo" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_email" });
    expect(m.issueSimpleInvoice).not.toHaveBeenCalled();
    expect(m.orderUpdateMany).not.toHaveBeenCalled();
  });

  it("comercio inexistente: 404", async () => {
    m.restaurantFindUnique.mockResolvedValue(null);
    const res = await call({});
    expect(res.status).toBe(404);
  });
});
