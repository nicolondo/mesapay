// /accounting/presupuesto: GET por año/mes (o ?month=YYYY-MM); POST forma
// inválida → 400 `invalid`, sin mes ni allMonths → 400, regla → 400 con su
// código, carrera → 409, alta → 201, actualización → 200; DELETE ?id.
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ upsert: vi.fn(), load: vi.fn(), del: vi.fn() }));
vi.mock("@/lib/secureApi", () => ({ secureApi: (h: unknown) => h }));
vi.mock("@/lib/erp/access", () => ({
  getErpContext: async () => ({ restaurantId: "r1", userId: "user-1" }),
  isDenied: () => false,
}));
vi.mock("@/lib/erp/budgets", () => ({
  upsertBudget: m.upsert,
  loadBudgetExecution: m.load,
  deleteBudget: m.del,
}));
import { DELETE, GET, POST } from "./route";

const URL_BASE = "http://localhost/api/operator/accounting/presupuesto";
const post = (body: unknown) =>
  POST(
    new Request(URL_BASE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

const good = { accountCode: "51", costCenterId: null, year: 2026, month: 9, amountCents: 1_000_000 };
const budget = {
  id: "b1",
  year: 2026,
  month: 9,
  accountCode: "51",
  accountName: "Operacionales de administración",
  costCenterId: null,
  costCenterName: null,
  monthlyCents: 1_000_000,
};

beforeEach(() => {
  vi.resetAllMocks();
  m.upsert.mockResolvedValue({ ok: true, budget, created: true });
  m.load.mockResolvedValue({ year: 2026, month: 9, rows: [], budgets: [] });
  m.del.mockResolvedValue({ ok: true });
});

describe("POST /accounting/presupuesto", () => {
  it("rechaza un cuerpo con forma inválida sin tocar la librería", async () => {
    const res = await post({ ...good, amountCents: "mucho" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid" });
    expect(m.upsert).not.toHaveBeenCalled();
  });

  it("rechaza JSON roto con 400", async () => {
    const res = await post("{no es json");
    expect(res.status).toBe(400);
    expect(m.upsert).not.toHaveBeenCalled();
  });

  it("sin mes y sin allMonths → 400 invalid_month", async () => {
    const res = await post({ ...good, month: undefined });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_month" });
    expect(m.upsert).not.toHaveBeenCalled();
  });

  it("devuelve 400 con el código de la regla de negocio", async () => {
    m.upsert.mockResolvedValue({ ok: false, error: "account_not_found" });
    const res = await post(good);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "account_not_found" });
  });

  it("carrera por el mismo alcance → 409 duplicate", async () => {
    m.upsert.mockResolvedValue({ ok: false, error: "duplicate" });
    const res = await post(good);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "duplicate" });
  });

  it("crea el presupuesto del mes y responde 201", async () => {
    const res = await post(good);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, budget, created: true });
    expect(m.upsert).toHaveBeenCalledWith("r1", {
      accountCode: "51",
      costCenterId: null,
      year: 2026,
      month: 9,
      amountCents: 1_000_000,
    });
  });

  it("actualiza uno existente y responde 200", async () => {
    m.upsert.mockResolvedValue({ ok: true, budget, created: false });
    const res = await post(good);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, created: false });
  });

  it("allMonths manda mes null (todo el año) y respeta el centro", async () => {
    const res = await post({ ...good, costCenterId: "cc-cocina", allMonths: true });
    expect(res.status).toBe(201);
    expect(m.upsert.mock.calls[0][1]).toEqual({
      accountCode: "51",
      costCenterId: "cc-cocina",
      year: 2026,
      month: null,
      amountCents: 1_000_000,
    });
  });
});

describe("GET /accounting/presupuesto", () => {
  it("acepta ?year&month y ?month=YYYY-MM", async () => {
    expect((await GET(new Request(`${URL_BASE}?year=2026&month=9`))).status).toBe(200);
    expect(m.load).toHaveBeenLastCalledWith("r1", 2026, 9);
    expect((await GET(new Request(`${URL_BASE}?month=2026-11`))).status).toBe(200);
    expect(m.load).toHaveBeenLastCalledWith("r1", 2026, 11);
  });

  it("período inválido → 400", async () => {
    expect((await GET(new Request(`${URL_BASE}?year=2026&month=13`))).status).toBe(400);
    expect((await GET(new Request(`${URL_BASE}?month=2026-9`))).status).toBe(400);
    expect((await GET(new Request(URL_BASE))).status).toBe(400);
    expect(m.load).not.toHaveBeenCalled();
  });
});

describe("DELETE /accounting/presupuesto", () => {
  it("borra por id; sin id → 400; ajeno → 404", async () => {
    expect((await DELETE(new Request(`${URL_BASE}?id=b1`, { method: "DELETE" }))).status).toBe(200);
    expect(m.del).toHaveBeenCalledWith("r1", "b1");
    expect((await DELETE(new Request(URL_BASE, { method: "DELETE" }))).status).toBe(400);
    m.del.mockResolvedValue({ ok: false, error: "not_found" });
    expect((await DELETE(new Request(`${URL_BASE}?id=b9`, { method: "DELETE" }))).status).toBe(404);
  });
});
