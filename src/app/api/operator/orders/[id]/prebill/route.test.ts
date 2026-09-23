// POST /prebill: manda la precuenta a la impresora de facturas o avisa que
// hay que imprimirla desde el navegador. Nunca numera ni cobra nada.
import { beforeEach, describe, expect, it, vi } from "vitest";

type AuditArgs = {
  kind: string;
  restaurantId?: string | null;
  target?: { type: string; id?: string };
  summary?: string;
};

const m = vi.hoisted(() => ({
  scope: vi.fn(),
  findUnique: vi.fn(),
  enqueue: vi.fn(),
  audit: vi.fn<(args: AuditArgs) => Promise<void>>(async () => {}),
}));
vi.mock("@/lib/secureApi", () => ({ secureApi: (h: unknown) => h }));
vi.mock("@/lib/operatorScope", () => ({
  requireOperatorScope: m.scope,
  isScopeError: (v: { error?: string }) => "error" in v,
}));
vi.mock("@/lib/db", () => ({ db: { order: { findUnique: m.findUnique } } }));
vi.mock("@/lib/print/prebillQueue", () => ({ enqueuePrebillTicket: m.enqueue }));
vi.mock("@/lib/auditLog", () => ({ recordAuditEvent: m.audit }));

import { POST } from "./route";

const post = () =>
  POST(new Request("http://localhost/api/operator/orders/order-1/prebill", { method: "POST" }), {
    params: Promise.resolve({ id: "order-1" }),
  });

beforeEach(() => {
  vi.resetAllMocks();
  m.scope.mockResolvedValue({ restaurantId: "rest-1", role: "mesero", userId: "user-1" });
  m.findUnique.mockResolvedValue({
    id: "order-1",
    restaurantId: "rest-1",
    status: "placed",
    shortCode: "A4F2",
  });
  m.enqueue.mockResolvedValue({ queued: true, printerName: "Caja", jobs: 1 });
  m.audit.mockResolvedValue(undefined);
});

describe("POST /operator/orders/[id]/prebill", () => {
  it("403 sin permiso (rol fuera del staff)", async () => {
    m.scope.mockResolvedValue({ error: "forbidden" });
    const res = await post();
    expect(res.status).toBe(403);
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it("400 sin restaurante activo", async () => {
    m.scope.mockResolvedValue({ error: "no_restaurant" });
    expect((await post()).status).toBe(400);
  });

  it("404 si la cuenta no existe", async () => {
    m.findUnique.mockResolvedValue(null);
    expect((await post()).status).toBe(404);
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it("403 si la cuenta es de otro comercio", async () => {
    m.findUnique.mockResolvedValue({
      id: "order-1",
      restaurantId: "otro",
      status: "placed",
      shortCode: "A4F2",
    });
    expect((await post()).status).toBe(403);
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it("409 si la cuenta ya está pagada: lo que corresponde es la factura", async () => {
    m.findUnique.mockResolvedValue({
      id: "order-1",
      restaurantId: "rest-1",
      status: "paid",
      shortCode: "A4F2",
    });
    const res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "order_closed" });
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it("sin impresora responde queued: false con el motivo (y deja rastro)", async () => {
    m.enqueue.mockResolvedValue({ queued: false, reason: "no_printer" });
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ queued: false, reason: "no_printer" });
    expect(m.audit).toHaveBeenCalledOnce();
    expect(m.audit.mock.calls[0][0]).toMatchObject({
      kind: "order.prebill.print",
      restaurantId: "rest-1",
      target: { type: "order", id: "order-1" },
    });
    expect(m.audit.mock.calls[0][0].summary).toContain("navegador");
  });

  it("con impresora encola con el comercio de la sesión y responde la impresora", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ queued: true, printerName: "Caja", jobs: 1 });
    expect(m.enqueue).toHaveBeenCalledWith({
      restaurantId: "rest-1",
      orderId: "order-1",
      requestedByUserId: "user-1",
    });
    expect(m.audit.mock.calls[0][0].summary).toBe("Imprimió precuenta A4F2 en Caja");
  });

  it("si la cola descubre que la cuenta se cerró en el medio, 409", async () => {
    m.enqueue.mockResolvedValue({ queued: false, reason: "order_closed" });
    expect((await post()).status).toBe(409);
    expect(m.audit).not.toHaveBeenCalled();
  });
});
