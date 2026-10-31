// POST del cierre del ejercicio: corre con el lock contable y, si el cierre
// ya es un comprobante numerado con diciembre cerrado, responde 409 con el
// número para que la pantalla explique cómo corregirlo (antes lo borraba).
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ gen: vi.fn(), lock: vi.fn() }));
vi.mock("@/lib/secureApi", () => ({ secureApi: (h: unknown) => h }));
vi.mock("@/lib/erp/access", () => ({
  getErpContext: async () => ({ restaurantId: "r1" }),
  isDenied: () => false,
}));
vi.mock("@/lib/erp/fiscal", () => ({
  generateYearClosing: m.gen,
  loadClosing: vi.fn(),
  loadTaxDeclaration: vi.fn(),
}));
vi.mock("@/lib/erp/autoJournal", () => ({
  MANUAL_LOCK_WAIT_MS: 20_000,
  withJournalLock: m.lock,
}));

import { POST } from "./route";

const post = () =>
  (POST as unknown as (r: Request) => Promise<Response>)(
    new Request("http://x/api/operator/accounting/fiscal?year=2026", { method: "POST" }),
  );

beforeEach(() => {
  vi.resetAllMocks();
  m.lock.mockImplementation(async (_id: string, fn: () => Promise<unknown>) => ({ ok: true, value: await fn() }));
});

describe("POST /api/operator/accounting/fiscal", () => {
  it("genera con el lock contable del comercio", async () => {
    m.gen.mockResolvedValue({ ok: true, closing: { year: "2026", exists: true } });
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ year: "2026", closing: { year: "2026", exists: true } });
    expect(m.lock).toHaveBeenCalledWith("r1", expect.any(Function), { waitMs: 20_000, holdMs: 60_000 });
  });

  it("cierre numerado con diciembre cerrado: 409 closing_locked con el número", async () => {
    m.gen.mockResolvedValue({ ok: false, error: "closing_locked", voucherNumber: 57 });
    const res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "closing_locked", voucherNumber: 57 });
  });

  it("si otro proceso tiene el lock, responde busy", async () => {
    m.lock.mockResolvedValue({ ok: false, reason: "busy" });
    const res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "busy" });
    expect(m.gen).not.toHaveBeenCalled();
  });
});
