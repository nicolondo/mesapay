// POST /accounting/deferred: forma inválida → 400 `invalid`; regla de
// negocio → 400 con su código; mes de inicio cerrado → 409; alta → 201.
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@/lib/secureApi", () => ({ secureApi: (h: unknown) => h }));
vi.mock("@/lib/erp/access", () => ({
  getErpContext: async () => ({ restaurantId: "r1", userId: "user-1" }),
  isDenied: () => false,
}));
vi.mock("@/lib/erp/deferred", () => ({ createDeferredItem: m.create }));
vi.mock("@/lib/erp/deferredQuery", () => ({
  listDeferredItems: async () => [],
  loadDeferredFormOptions: async () => ({ accounts: {}, centers: [] }),
}));
import { POST } from "./route";

const post = (body: unknown) =>
  POST(
    new Request("http://localhost/api/operator/accounting/deferred", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

const good = {
  name: "Seguro anual",
  kind: "expense",
  totalCents: 1_200_000,
  startDate: "2026-09-15",
  months: 12,
  sourceAccountCode: "111005",
  deferralAccountCode: "170505",
  targetAccountCode: "513005",
  costCenterId: null,
  notes: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  m.create.mockResolvedValue({ ok: true, item: { id: "def-1" }, entryId: "entry-1" });
});

describe("POST /accounting/deferred", () => {
  it("rechaza un cuerpo con forma inválida sin tocar la librería", async () => {
    const res = await post({ ...good, totalCents: "mucho" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid" });
    expect(m.create).not.toHaveBeenCalled();
  });

  it("rechaza JSON roto con 400", async () => {
    const res = await post("{no es json");
    expect(res.status).toBe(400);
    expect(m.create).not.toHaveBeenCalled();
  });

  it("devuelve 400 con el código de la regla de negocio", async () => {
    m.create.mockResolvedValue({ ok: false, error: "deferral_account_invalid" });
    const res = await post(good);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "deferral_account_invalid" });
  });

  it("mes de inicio cerrado → 409 period_closed", async () => {
    m.create.mockResolvedValue({ ok: false, error: "period_closed" });
    const res = await post(good);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "period_closed" });
  });

  it("crea el diferido con el actor del contexto y responde 201", async () => {
    const res = await post(good);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, id: "def-1", entryId: "entry-1" });
    expect(m.create).toHaveBeenCalledOnce();
    expect(m.create.mock.calls[0][0]).toEqual({
      restaurantId: "r1",
      actorId: "user-1",
      input: good,
    });
  });
});
