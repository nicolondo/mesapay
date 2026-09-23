// Configuración → Impresoras → Facturas: la puerta, la validación (la
// impresora elegida tiene que ser del comercio y estar activa) y qué se
// escribe en el comercio.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  activeRestaurantId: vi.fn(),
  printerFindFirst: vi.fn(),
  restaurantUpdate: vi.fn(),
  recordAuditEvent: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/activeRestaurant", () => ({
  getActiveRestaurantId: m.activeRestaurantId,
}));
vi.mock("@/lib/db", () => ({
  db: {
    printer: { findFirst: m.printerFindFirst },
    restaurant: { update: m.restaurantUpdate },
  },
}));
vi.mock("@/lib/auditLog", () => ({ recordAuditEvent: m.recordAuditEvent }));

import { PATCH } from "./route";

const call = (body: unknown) =>
  PATCH(
    new Request("http://localhost/api/operator/invoice-printing", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  ) as Promise<Response>;

beforeEach(() => {
  vi.resetAllMocks();
  m.auth.mockResolvedValue({ user: { id: "u", role: "operator" } });
  m.activeRestaurantId.mockResolvedValue("rest-1");
  m.printerFindFirst.mockResolvedValue({ id: "p-caja", active: true });
  m.restaurantUpdate.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
    invoicePrinterId: args.data.invoicePrinterId ?? null,
    invoiceAutoPrint: args.data.invoiceAutoPrint ?? true,
  }));
  m.recordAuditEvent.mockResolvedValue(undefined);
});

describe("la puerta", () => {
  it.each([undefined, "mesero", "kitchen", "group_admin"])(
    "el rol %s no puede (403) y no toca nada",
    async (role) => {
      m.auth.mockResolvedValue(role ? { user: { role } } : null);
      expect((await call({ invoiceAutoPrint: false })).status).toBe(403);
      expect(m.restaurantUpdate).not.toHaveBeenCalled();
    },
  );

  it.each(["operator", "platform_admin"])("el rol %s sí", async (role) => {
    m.auth.mockResolvedValue({ user: { role } });
    expect((await call({ invoiceAutoPrint: false })).status).toBe(200);
  });

  it("sin comercio activo ⇒ 400", async () => {
    m.activeRestaurantId.mockResolvedValue(null);
    const res = await call({ invoiceAutoPrint: false });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "no_restaurant" });
  });
});

describe("el body", () => {
  it.each([
    ["vacío", {}],
    ["sin JSON", "no es json"],
    ["tipo equivocado", { invoiceAutoPrint: "sí" }],
    ["id vacío", { invoicePrinterId: "" }],
  ])("%s ⇒ 400 invalid", async (_name, body) => {
    const res = await call(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid" });
    expect(m.restaurantUpdate).not.toHaveBeenCalled();
  });
});

describe("la impresora elegida", () => {
  it("se busca acotada al comercio: la de otro es 404 y no se guarda", async () => {
    m.printerFindFirst.mockResolvedValue(null);
    const res = await call({ invoicePrinterId: "p-ajena" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "printer_not_found" });
    expect(m.printerFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "p-ajena", restaurantId: "rest-1" } }),
    );
    expect(m.restaurantUpdate).not.toHaveBeenCalled();
  });

  it("apagada ⇒ 409 printer_inactive y no se guarda", async () => {
    m.printerFindFirst.mockResolvedValue({ id: "p-caja", active: false });
    const res = await call({ invoicePrinterId: "p-caja" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "printer_inactive" });
    expect(m.restaurantUpdate).not.toHaveBeenCalled();
  });

  it("activa y del comercio ⇒ se guarda en el comercio", async () => {
    const res = await call({ invoicePrinterId: "p-caja" });
    expect(res.status).toBe(200);
    expect(m.restaurantUpdate).toHaveBeenCalledWith({
      where: { id: "rest-1" },
      data: { invoicePrinterId: "p-caja" },
      select: { invoicePrinterId: true, invoiceAutoPrint: true },
    });
    expect(await res.json()).toEqual({
      ok: true,
      settings: { invoicePrinterId: "p-caja", invoiceAutoPrint: true },
    });
  });

  it("null = volver a 'todas las de tipo factura', sin buscar ninguna impresora", async () => {
    const res = await call({ invoicePrinterId: null });
    expect(res.status).toBe(200);
    expect(m.printerFindFirst).not.toHaveBeenCalled();
    expect(m.restaurantUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { invoicePrinterId: null } }),
    );
  });
});

describe("el automático", () => {
  it("se apaga y se prende solo, sin tocar la impresora elegida", async () => {
    await call({ invoiceAutoPrint: false });
    expect(m.restaurantUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { invoiceAutoPrint: false } }),
    );
    expect(m.printerFindFirst).not.toHaveBeenCalled();
  });

  it("los dos ajustes juntos van en un solo update", async () => {
    await call({ invoicePrinterId: "p-caja", invoiceAutoPrint: false });
    expect(m.restaurantUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { invoicePrinterId: "p-caja", invoiceAutoPrint: false },
      }),
    );
  });

  it("deja constancia en la auditoría", async () => {
    await call({ invoiceAutoPrint: false });
    expect(m.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "printer.invoice_settings.update",
        restaurantId: "rest-1",
        target: { type: "restaurant", id: "rest-1" },
        diff: { after: { invoicePrinterId: null, invoiceAutoPrint: false } },
      }),
    );
  });
});
