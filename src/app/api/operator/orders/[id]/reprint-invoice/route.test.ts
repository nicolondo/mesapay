// Reimpresión de la factura desde la lista/detalle de pedidos. Lo que se
// blinda acá es la puerta y el contrato con la UI: quién puede, de qué
// comercio, qué pasa sin factura y sin impresora, que a la cola le llegan
// EXACTAMENTE los mismos argumentos que al cobrar (más `reprint`), y QUÉ
// documento sale: la factura electrónica sólo si la DIAN ya la aceptó.
// El encolado en sí se prueba en `src/lib/print/invoiceQueue.test.ts`.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  activeRestaurantId: vi.fn(),
  invoiceFindUnique: vi.fn(),
  enqueueInvoicePrint: vi.fn(),
  recordAuditEvent: vi.fn(),
  dianEnvironment: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/activeRestaurant", () => ({
  getActiveRestaurantId: m.activeRestaurantId,
}));
vi.mock("@/lib/db", () => ({
  db: { simpleInvoice: { findUnique: m.invoiceFindUnique } },
}));
vi.mock("@/lib/print/invoiceQueue", () => ({
  enqueueInvoicePrint: m.enqueueInvoicePrint,
}));
vi.mock("@/lib/auditLog", () => ({ recordAuditEvent: m.recordAuditEvent }));
// Sólo `dianEnvironment`: no descifra nada y acá tampoco hay config.
vi.mock("@/lib/dian/config", () => ({ dianEnvironment: m.dianEnvironment }));

import { POST } from "./route";

const snapshot = {
  restaurantName: "Donde Chucho",
  invoicePrefix: "POS",
  shortCode: "002A77-77C496-58E6EF-6C25C8",
  items: [],
};

function invoice(over: Record<string, unknown> = {}) {
  return {
    id: "inv-1",
    restaurantId: "rest-1",
    orderId: "order-1",
    invoiceNumber: 42,
    snapshot,
    order: { locale: "pt", shortCode: "002A77-77C496-58E6EF-6C25C8" },
    dianDocument: null,
    restaurant: { enabledModules: [] },
    ...over,
  };
}

/** Comercio con facturación electrónica y la factura en el estado dado. */
function einvoice(state: string, cufe: string | null = "CUFE-1") {
  return invoice({
    dianDocument: { state, cufe },
    restaurant: { enabledModules: ["einvoicing"] },
  });
}

const call = () =>
  POST(
    new Request("http://localhost/api/operator/orders/order-1/reprint-invoice", {
      method: "POST",
    }),
    { params: Promise.resolve({ id: "order-1" }) },
  ) as Promise<Response>;

beforeEach(() => {
  vi.resetAllMocks();
  m.auth.mockResolvedValue({
    user: { id: "user-1", role: "operator", email: "caja@chucho.co" },
  });
  m.activeRestaurantId.mockResolvedValue("rest-1");
  m.invoiceFindUnique.mockResolvedValue(invoice());
  m.enqueueInvoicePrint.mockResolvedValue(1);
  m.recordAuditEvent.mockResolvedValue(undefined);
  m.dianEnvironment.mockResolvedValue("produccion");
});

describe("la puerta", () => {
  it.each(["mesero", "kitchen", "bar", "terminal", "diner"])(
    "el rol %s no reimprime (401) y no toca la cola",
    async (role) => {
      m.auth.mockResolvedValue({ user: { id: "u", role } });
      const res = await call();
      expect(res.status).toBe(401);
      expect(m.invoiceFindUnique).not.toHaveBeenCalled();
      expect(m.enqueueInvoicePrint).not.toHaveBeenCalled();
    },
  );

  it.each(["operator", "platform_admin", "group_admin"])(
    "el rol %s sí puede",
    async (role) => {
      m.auth.mockResolvedValue({ user: { id: "u", role } });
      const res = await call();
      expect(res.status).toBe(200);
    },
  );

  it("sin sesión ⇒ 401", async () => {
    m.auth.mockResolvedValue(null);
    expect((await call()).status).toBe(401);
  });

  it("sin comercio activo ⇒ 400", async () => {
    m.activeRestaurantId.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "no_restaurant" });
  });
});

describe("qué factura", () => {
  it("busca la tirilla por la orden (orderId es único), con su documento DIAN y los módulos", async () => {
    await call();
    expect(m.invoiceFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orderId: "order-1" },
        select: expect.objectContaining({
          dianDocument: { select: { state: true, cufe: true } },
          restaurant: { select: { enabledModules: true } },
        }),
      }),
    );
  });

  it("una cuenta sin factura ⇒ 404 no_invoice", async () => {
    m.invoiceFindUnique.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "no_invoice" });
    expect(m.enqueueInvoicePrint).not.toHaveBeenCalled();
  });

  it("la factura de OTRO comercio es indistinguible de la que no existe", async () => {
    m.invoiceFindUnique.mockResolvedValue(invoice({ restaurantId: "rest-vecino" }));
    const res = await call();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "no_invoice" });
    expect(m.enqueueInvoicePrint).not.toHaveBeenCalled();
    expect(m.recordAuditEvent).not.toHaveBeenCalled();
  });
});

describe("el encolado", () => {
  it("manda a la cola lo mismo que el cobro, con reprint para saltar la idempotencia", async () => {
    await call();
    expect(m.enqueueInvoicePrint).toHaveBeenCalledWith({
      restaurantId: "rest-1",
      orderId: "order-1",
      invoiceId: "inv-1",
      invoiceNumber: 42,
      snapshot,
      // El idioma es el de la ORDEN, no el del que aprieta el botón.
      locale: "pt",
      reprint: true,
    });
  });

  it("con impresora ⇒ queued: true, cuántas copias salieron y qué documento", async () => {
    m.enqueueInvoicePrint.mockResolvedValue(2);
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      queued: true,
      printers: 2,
      document: "comprobante",
    });
  });

  it("sin impresora de facturas ⇒ queued: false, no_printer (200, no es un error)", async () => {
    m.enqueueInvoicePrint.mockResolvedValue(0);
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ queued: false, reason: "no_printer" });
    // No salió nada: no hay acción que auditar.
    expect(m.recordAuditEvent).not.toHaveBeenCalled();
  });

  it("si la cola revienta responde 500 print_failed sin lanzar", async () => {
    m.enqueueInvoicePrint.mockRejectedValue(new Error("db caída"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await call();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "print_failed" });
    expect(m.recordAuditEvent).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("qué documento sale — la factura electrónica sólo si la DIAN la aceptó", () => {
  it("aceptada ⇒ va con CUFE y la URL del QR del catálogo de producción", async () => {
    m.invoiceFindUnique.mockResolvedValue(einvoice("accepted"));
    const res = await call();
    expect(m.dianEnvironment).toHaveBeenCalledWith("rest-1");
    expect(m.enqueueInvoicePrint).toHaveBeenCalledWith(
      expect.objectContaining({
        reprint: true,
        dian: {
          cufe: "CUFE-1",
          qrUrl: "https://catalogo-vpfe.dian.gov.co/document/searchqr?documentkey=CUFE-1",
        },
      }),
    );
    expect(await res.json()).toEqual({
      queued: true,
      printers: 1,
      document: "factura_electronica",
    });
  });

  it("en habilitación la URL apunta al catálogo -hab", async () => {
    m.invoiceFindUnique.mockResolvedValue(einvoice("accepted"));
    m.dianEnvironment.mockResolvedValue("habilitacion");
    await call();
    expect(m.enqueueInvoicePrint.mock.calls[0][0].dian.qrUrl).toMatch(
      /^https:\/\/catalogo-vpfe-hab\.dian\.gov\.co\//,
    );
  });

  it.each(["rejected", "pending", "to_send", "error"])(
    "en estado %s sale el comprobante: no existe factura electrónica que ofrecer",
    async (state) => {
      m.invoiceFindUnique.mockResolvedValue(einvoice(state));
      const res = await call();
      expect(m.enqueueInvoicePrint.mock.calls[0][0]).not.toHaveProperty("dian");
      expect(m.dianEnvironment).not.toHaveBeenCalled();
      // Y lo avisa: la UI dice que salió el comprobante, no la electrónica.
      expect(await res.json()).toEqual({
        queued: true,
        printers: 1,
        document: "comprobante",
        dianPending: true,
      });
    },
  );

  it("aceptada pero sin CUFE guardado ⇒ comprobante (no se inventa un QR)", async () => {
    m.invoiceFindUnique.mockResolvedValue(einvoice("accepted", null));
    await call();
    expect(m.enqueueInvoicePrint.mock.calls[0][0]).not.toHaveProperty("dian");
  });

  it("sin el módulo einvoicing un documento aceptado no cuenta", async () => {
    m.invoiceFindUnique.mockResolvedValue(
      invoice({ dianDocument: { state: "accepted", cufe: "CUFE-1" } }),
    );
    const res = await call();
    expect(m.enqueueInvoicePrint.mock.calls[0][0]).not.toHaveProperty("dian");
    expect(m.dianEnvironment).not.toHaveBeenCalled();
    // Sin facturación electrónica no hay nada "pendiente" que avisar.
    expect(await res.json()).not.toHaveProperty("dianPending");
  });
});

describe("auditoría", () => {
  it("deja constancia de quién reimprimió qué factura, con el código corto de la cuenta", async () => {
    await call();
    expect(m.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "invoice.reprint",
        restaurantId: "rest-1",
        target: { type: "order", id: "order-1" },
        summary: "Reimprimió factura POS42 de la cuenta 002A77",
        diff: {
          after: { invoiceId: "inv-1", printers: 1, document: "comprobante" },
        },
      }),
    );
  });

  it("y dice 'factura electrónica' cuando eso fue lo que salió", async () => {
    m.invoiceFindUnique.mockResolvedValue(einvoice("accepted"));
    await call();
    expect(m.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: "Reimprimió factura electrónica POS42 de la cuenta 002A77",
        diff: {
          after: { invoiceId: "inv-1", printers: 1, document: "factura_electronica" },
        },
      }),
    );
  });
});
