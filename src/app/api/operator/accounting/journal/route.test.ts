// Botón «Generar / actualizar asientos»: toma el mismo lock que la corrida
// diaria, respeta el candado de cierre y devuelve la última actualización.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  lock: vi.fn(),
  regen: vi.fn(),
  last: vi.fn(),
  cfg: vi.fn(),
  load: vi.fn(),
}));

vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/lib/erp/access", () => ({
  getErpContext: async () => ({ restaurantId: "r1", country: "CO", userId: "u1" }),
  isDenied: (ctx: object) => "error" in ctx,
}));
vi.mock("@/lib/erp/cierre", () => ({
  getAccountingConfig: m.cfg,
  isMonthClosed: (closedThrough: string | null, month: string) => closedThrough != null && month <= closedThrough,
}));
vi.mock("@/lib/erp/posting", () => ({ loadJournalForMonth: m.load }));
vi.mock("@/lib/erp/autoJournal", () => ({
  MANUAL_LOCK_WAIT_MS: 20_000,
  MANUAL_LOCK_HOLD_MS: 120_000,
  withJournalLock: m.lock,
  regenerateMonth: m.regen,
  lastEngineUpdateAt: m.last,
}));

import { GET, POST } from "./route";

const req = (method: "GET" | "POST", month = "2026-10") =>
  new Request(`http://localhost/api/operator/accounting/journal?month=${month}`, { method });

const AT = new Date("2026-10-31T10:30:12Z");

beforeEach(() => {
  vi.resetAllMocks();
  m.cfg.mockResolvedValue({ uvtCents: 1, closedThrough: null, nextVoucherNumber: 1 });
  m.load.mockResolvedValue([{ id: "e1" }]);
  m.last.mockResolvedValue(AT);
  m.lock.mockImplementation(async (_id: string, fn: () => Promise<unknown>) => ({ ok: true, value: await fn() }));
  m.regen.mockImplementation(async (_r: string, month: string) => ({ month, status: "ok", results: [] }));
});

describe("GET /api/operator/accounting/journal", () => {
  it("devuelve la última actualización de los asientos del motor del mes", async () => {
    const body = await (await GET(req("GET"))).json();
    expect(m.last).toHaveBeenCalledWith("r1", "2026-10");
    expect(body).toMatchObject({ month: "2026-10", lastGeneratedAt: AT.toISOString(), monthClosed: false });
  });

  it("null si el mes no tiene asientos del motor", async () => {
    m.last.mockResolvedValue(null);
    expect((await (await GET(req("GET"))).json()).lastGeneratedAt).toBeNull();
  });
});

describe("POST /api/operator/accounting/journal", () => {
  it("regenera el mes con el lock del comercio (espera hasta 20 s)", async () => {
    const res = await POST(req("POST"));
    expect(res.status).toBe(200);
    expect(m.lock).toHaveBeenCalledWith("r1", expect.any(Function), { waitMs: 20_000, holdMs: 120_000 });
    expect(m.regen).toHaveBeenCalledWith("r1", "2026-10", null);
    expect(await res.json()).toMatchObject({ entries: [{ id: "e1" }], lastGeneratedAt: AT.toISOString() });
  });

  it("409 busy si la corrida diaria tiene el lock", async () => {
    m.lock.mockResolvedValue({ ok: false, reason: "busy" });
    const res = await POST(req("POST"));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "busy" });
    expect(m.regen).not.toHaveBeenCalled();
  });

  it("409 month_closed en un mes cerrado (el candado se lee dentro del lock)", async () => {
    m.cfg.mockResolvedValue({ uvtCents: 1, closedThrough: "2026-10", nextVoucherNumber: 9 });
    m.regen.mockResolvedValue({ month: "2026-10", status: "closed" });
    const res = await POST(req("POST"));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "month_closed", closedThrough: "2026-10" });
    expect(m.regen).toHaveBeenCalledWith("r1", "2026-10", "2026-10");
  });

  it("400 con un mes inválido, sin tomar el lock", async () => {
    expect((await POST(req("POST", "2026-13"))).status).toBe(400);
    expect(m.lock).not.toHaveBeenCalled();
  });
});
