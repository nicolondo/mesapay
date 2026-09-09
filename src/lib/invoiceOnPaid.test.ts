import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * El helper habla con la DB y con el emisor de facturas, así que los dos van
 * mockeados. Lo que se prueba es la DECISIÓN: cuándo emite y cuándo no —
 * incluida la idempotencia, que es lo que impide que una orden pagada por dos
 * rieles (webhook + settle manual) mande dos facturas.
 */

type OrderRow = {
  id: string;
  restaurantId: string;
  status: string;
  simpleInvoiceEmail: string | null;
  simpleInvoice: { id: string } | null;
};

const state: {
  order: OrderRow | null;
  request: Record<string, unknown> | null;
} = { order: null, request: null };

const findUniqueOrder = vi.fn(async () => state.order);
const findFirstRequest = vi.fn(async () => state.request);

vi.mock("@/lib/db", () => ({
  db: {
    order: {
      findUnique: (...args: unknown[]) => findUniqueOrder(...(args as [])),
    },
    invoiceRequest: {
      findFirst: (...args: unknown[]) => findFirstRequest(...(args as [])),
    },
  },
}));

const issueSimpleInvoice = vi.fn();
const sendSimpleInvoiceEmail = vi.fn(async () => undefined);

vi.mock("@/lib/simpleInvoice", () => ({
  issueSimpleInvoice: (...args: unknown[]) =>
    issueSimpleInvoice(...(args as [])),
  sendSimpleInvoiceEmail: (...args: unknown[]) =>
    sendSimpleInvoiceEmail(...(args as [])),
}));

const { issueRequestedInvoiceOnPaid } = await import("./invoiceOnPaid");

const PAID_ORDER: OrderRow = {
  id: "order-1",
  restaurantId: "rest-1",
  status: "paid",
  simpleInvoiceEmail: null,
  simpleInvoice: null,
};

const PENDING_REQUEST = {
  id: "req-1",
  email: "ana@correo.com",
  customerName: "Ana Pérez",
  docType: "CC",
  docNumber: "1020304050",
  address: "Calle 1 #2-3",
  city: "Bogotá",
  department: "Cundinamarca",
};

function issuedOk() {
  return {
    ok: true,
    invoiceId: "inv-1",
    invoiceUrl: "https://mesapay.co/factura/inv-1",
    invoiceNumber: 7,
    snapshot: { restaurantName: "Test" },
    email: "ana@correo.com",
    locale: "es",
    alreadyIssued: false,
  };
}

beforeEach(() => {
  state.order = null;
  state.request = null;
  issueSimpleInvoice.mockReset();
  sendSimpleInvoiceEmail.mockReset();
  issueSimpleInvoice.mockResolvedValue(issuedOk());
});

describe("issueRequestedInvoiceOnPaid", () => {
  it("no emite si la orden todavía no está pagada", async () => {
    state.order = { ...PAID_ORDER, status: "paying" };
    state.request = PENDING_REQUEST;

    await issueRequestedInvoiceOnPaid({
      tenantId: "rest-1",
      orderId: "order-1",
    });

    expect(issueSimpleInvoice).not.toHaveBeenCalled();
    expect(sendSimpleInvoiceEmail).not.toHaveBeenCalled();
  });

  it("no emite si nadie pidió factura", async () => {
    state.order = PAID_ORDER;
    state.request = null;

    await issueRequestedInvoiceOnPaid({
      tenantId: "rest-1",
      orderId: "order-1",
    });

    expect(issueSimpleInvoice).not.toHaveBeenCalled();
  });

  it("emite y envía cuando hay solicitud personalizada y la orden está pagada", async () => {
    state.order = PAID_ORDER;
    state.request = PENDING_REQUEST;

    await issueRequestedInvoiceOnPaid({
      tenantId: "rest-1",
      orderId: "order-1",
    });

    expect(issueSimpleInvoice).toHaveBeenCalledTimes(1);
    expect(issueSimpleInvoice).toHaveBeenCalledWith({
      tenantId: "rest-1",
      orderId: "order-1",
      email: "ana@correo.com",
      customer: {
        name: "Ana Pérez",
        docType: "CC",
        docNumber: "1020304050",
        address: "Calle 1 #2-3",
        city: "Bogotá",
        department: "Cundinamarca",
      },
    });
    expect(sendSimpleInvoiceEmail).toHaveBeenCalledTimes(1);
  });

  it("emite la genérica cuando sólo quedó el correo del checkout", async () => {
    state.order = { ...PAID_ORDER, simpleInvoiceEmail: "ana@correo.com" };
    state.request = null;

    await issueRequestedInvoiceOnPaid({
      tenantId: "rest-1",
      orderId: "order-1",
    });

    expect(issueSimpleInvoice).toHaveBeenCalledWith({
      tenantId: "rest-1",
      orderId: "order-1",
      email: "ana@correo.com",
      customer: null,
    });
  });

  // Idempotencia: la orden puede pasar por dos rieles (webhook de Kushki +
  // pse-return, o settle manual tras un pending). La segunda pasada NO puede
  // volver a emitir ni a mandar el correo.
  it("no re-emite si la orden ya tiene factura", async () => {
    state.order = PAID_ORDER;
    state.request = PENDING_REQUEST;

    await issueRequestedInvoiceOnPaid({
      tenantId: "rest-1",
      orderId: "order-1",
    });
    // Segunda pasada: la orden ya trae su SimpleInvoice.
    state.order = { ...PAID_ORDER, simpleInvoice: { id: "inv-1" } };
    await issueRequestedInvoiceOnPaid({
      tenantId: "rest-1",
      orderId: "order-1",
    });

    expect(issueSimpleInvoice).toHaveBeenCalledTimes(1);
    expect(sendSimpleInvoiceEmail).toHaveBeenCalledTimes(1);
  });

  it("no manda correo si la emisión devolvió una factura ya existente", async () => {
    state.order = PAID_ORDER;
    state.request = PENDING_REQUEST;
    issueSimpleInvoice.mockResolvedValue({
      ...issuedOk(),
      alreadyIssued: true,
    });

    await issueRequestedInvoiceOnPaid({
      tenantId: "rest-1",
      orderId: "order-1",
    });

    expect(sendSimpleInvoiceEmail).not.toHaveBeenCalled();
  });

  it("no toca órdenes de otro comercio", async () => {
    state.order = PAID_ORDER;
    state.request = PENDING_REQUEST;

    await issueRequestedInvoiceOnPaid({
      tenantId: "otro-rest",
      orderId: "order-1",
    });

    expect(issueSimpleInvoice).not.toHaveBeenCalled();
  });

  // Un fallo acá no puede tumbar el cobro que lo llamó.
  it("nunca lanza aunque la emisión falle", async () => {
    state.order = PAID_ORDER;
    state.request = PENDING_REQUEST;
    issueSimpleInvoice.mockRejectedValue(new Error("boom"));
    // El helper loguea el fallo a propósito; lo silenciamos para no ensuciar
    // la salida del test suite.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      issueRequestedInvoiceOnPaid({ tenantId: "rest-1", orderId: "order-1" }),
    ).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});
