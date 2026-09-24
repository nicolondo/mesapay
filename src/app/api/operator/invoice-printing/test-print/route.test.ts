// El botón "Imprimir factura de prueba": la puerta y el contrato con la
// UI (202 + cuántos trabajos, o 404 cuando no hay impresora para
// facturas). Qué se encola y a dónde se prueba en print/testTicket e
// invoiceQueue.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  activeRestaurantId: vi.fn(),
  enqueueInvoicePrintTest: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/activeRestaurant", () => ({
  getActiveRestaurantId: m.activeRestaurantId,
}));
vi.mock("@/lib/print/testTicket", () => ({
  enqueueInvoicePrintTest: m.enqueueInvoicePrintTest,
}));

import { POST } from "./route";

const call = () =>
  POST(
    new Request("http://localhost/api/operator/invoice-printing/test-print", {
      method: "POST",
    }),
  ) as Promise<Response>;

beforeEach(() => {
  vi.resetAllMocks();
  m.auth.mockResolvedValue({ user: { id: "u", role: "operator" } });
  m.activeRestaurantId.mockResolvedValue("rest-1");
  m.enqueueInvoicePrintTest.mockResolvedValue(1);
});

describe("la puerta", () => {
  it.each([undefined, "mesero", "kitchen"])("el rol %s no puede (403)", async (role) => {
    m.auth.mockResolvedValue(role ? { user: { role } } : null);
    expect((await call()).status).toBe(403);
    expect(m.enqueueInvoicePrintTest).not.toHaveBeenCalled();
  });

  it("sin comercio activo ⇒ 400", async () => {
    m.activeRestaurantId.mockResolvedValue(null);
    expect((await call()).status).toBe(400);
    expect(m.enqueueInvoicePrintTest).not.toHaveBeenCalled();
  });
});

describe("el encolado", () => {
  it("encola para el comercio activo y responde 202 con cuántos trabajos", async () => {
    m.enqueueInvoicePrintTest.mockResolvedValue(2);
    const res = await call();
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, jobs: 2 });
    expect(m.enqueueInvoicePrintTest).toHaveBeenCalledWith({ restaurantId: "rest-1" });
  });

  it("sin impresora activa para facturas ⇒ 404 no_printer", async () => {
    m.enqueueInvoicePrintTest.mockResolvedValue(0);
    const res = await call();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "no_printer" });
  });
});
