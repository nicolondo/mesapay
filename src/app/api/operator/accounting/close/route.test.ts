// Cerrar el mes toma el lock contable: no numera asientos que la corrida
// diaria (o el botón del Diario) está por borrar y recrear.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ lock: vi.fn(), close: vi.fn(), reopen: vi.fn() }));

vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/lib/erp/access", () => ({
  getErpContext: async () => ({ restaurantId: "r1", country: "CO", userId: "u1" }),
  isDenied: (ctx: object) => "error" in ctx,
}));
vi.mock("@/lib/erp/cierre", () => ({
  closeMonth: m.close,
  reopenLastMonth: m.reopen,
  getAccountingConfig: vi.fn(),
}));
vi.mock("@/lib/erp/autoJournal", () => ({ MANUAL_LOCK_WAIT_MS: 20_000, withJournalLock: m.lock }));

import { POST } from "./route";

const req = (body: unknown) =>
  new Request("http://localhost/api/operator/accounting/close", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.resetAllMocks();
  m.lock.mockImplementation(async (_id: string, fn: () => Promise<unknown>) => ({ ok: true, value: await fn() }));
  m.close.mockResolvedValue({ ok: true, numbered: 4, closedThrough: "2026-10" });
});

describe("POST /api/operator/accounting/close", () => {
  it("cierra el mes con el lock contable del comercio tomado", async () => {
    const res = await POST(req({ action: "close", month: "2026-10" }));
    expect(res.status).toBe(200);
    expect(m.lock).toHaveBeenCalledWith("r1", expect.any(Function), expect.objectContaining({ waitMs: 20_000 }));
    expect(m.close).toHaveBeenCalledWith("r1", "2026-10");
  });

  it("409 busy si los asientos se están regenerando", async () => {
    m.lock.mockResolvedValue({ ok: false, reason: "busy" });
    const res = await POST(req({ action: "close", month: "2026-10" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "busy" });
    expect(m.close).not.toHaveBeenCalled();
  });

  it("reabrir no necesita el lock (sólo retrocede el candado)", async () => {
    m.reopen.mockResolvedValue({ ok: true, closedThrough: "2026-09" });
    const res = await POST(req({ action: "reopen" }));
    expect(res.status).toBe(200);
    expect(m.lock).not.toHaveBeenCalled();
  });
});
