// POST /shifts/[id]/print: la tirilla del cierre de turno, por la impresora
// de caja o (con { destination: "device" }) en el equipo de quien la pide.
import { beforeEach, describe, expect, it, vi } from "vitest";

type AuditArgs = { kind: string; target?: { type: string; id?: string }; summary?: string };

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
vi.mock("@/lib/db", () => ({ db: { shift: { findUnique: m.findUnique } } }));
vi.mock("@/lib/print/shiftCloseQueue", () => ({ enqueueShiftCloseTicket: m.enqueue }));
vi.mock("@/lib/auditLog", () => ({ recordAuditEvent: m.audit }));

import { POST } from "./route";

const post = (body?: string) =>
  POST(
    new Request("http://localhost/api/operator/shifts/shift-1/print", {
      method: "POST",
      ...(body !== undefined && { body }),
    }),
    { params: Promise.resolve({ id: "shift-1" }) },
  );

beforeEach(() => {
  vi.resetAllMocks();
  m.scope.mockResolvedValue({ restaurantId: "rest-1", role: "operator", userId: "user-1" });
  m.findUnique.mockResolvedValue({ id: "shift-1", restaurantId: "rest-1" });
  m.enqueue.mockResolvedValue({ queued: true, printerName: "Caja", jobs: 1 });
  m.audit.mockResolvedValue(undefined);
});

describe("POST /operator/shifts/[id]/print", () => {
  it("sólo el panel del operador (los que ven el reporte del turno)", async () => {
    await post();
    expect(m.scope).toHaveBeenCalledWith(["operator", "platform_admin", "group_admin"]);
    m.scope.mockResolvedValue({ error: "forbidden" });
    expect((await post()).status).toBe(403);
  });

  it("un turno de otro comercio (o inexistente) es 404, sin encolar", async () => {
    m.findUnique.mockResolvedValue({ id: "shift-1", restaurantId: "otro" });
    expect((await post()).status).toBe(404);
    m.findUnique.mockResolvedValue(null);
    expect((await post()).status).toBe(404);
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it("impresora de caja: encola y dice cuál, con rastro", async () => {
    const res = await post();
    expect(await res.json()).toEqual({ queued: true, printerName: "Caja", jobs: 1 });
    expect(m.enqueue).toHaveBeenCalledWith({
      restaurantId: "rest-1",
      shiftId: "shift-1",
      requestedByUserId: "user-1",
    });
    expect(m.audit.mock.calls[0][0]).toMatchObject({
      kind: "shift.close.print",
      target: { type: "shift", id: "shift-1" },
      summary: "Imprimió el cierre de turno en Caja",
    });
  });

  it("sin impresora: queued false con el motivo (el cliente imprime en el navegador)", async () => {
    m.enqueue.mockResolvedValue({ queued: false, reason: "no_printer" });
    expect(await (await post()).json()).toEqual({ queued: false, reason: "no_printer" });
  });

  it("«Este dispositivo»: no encola, deja rastro y responde reason device", async () => {
    const res = await post(JSON.stringify({ destination: "device" }));
    expect(await res.json()).toEqual({ queued: false, reason: "device" });
    expect(m.enqueue).not.toHaveBeenCalled();
    expect(m.audit.mock.calls[0][0].summary).toBe("Imprimió el cierre de turno en su dispositivo");
  });
});
