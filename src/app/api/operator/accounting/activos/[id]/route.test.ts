// PATCH /accounting/activos/[id]: 404 si no es del comercio, 400 `invalid`
// por forma, 400 con el código de la regla (validación del conjunto
// completo: lo que no viene se conserva), 200 con el activo actualizado.
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ findFirst: vi.fn(), update: vi.fn(), detail: vi.fn() }));
vi.mock("@/lib/secureApi", () => ({ secureApi: (h: unknown) => h }));
vi.mock("@/lib/erp/access", () => ({
  getErpContext: async () => ({ restaurantId: "r1", userId: "user-1" }),
  isDenied: () => false,
}));
vi.mock("@/lib/erp/activosQuery", () => ({ loadAssetDetail: m.detail }));
vi.mock("@/lib/db", () => ({
  db: {
    fixedAsset: { findFirst: m.findFirst, update: m.update },
    ledgerAccount: {
      findMany: async () => [
        { code: "152005", active: true, postable: true },
        { code: "152405", active: true, postable: true },
        { code: "159205", active: true, postable: true },
        { code: "516005", active: true, postable: true },
        { code: "516010", active: true, postable: true },
      ],
    },
  },
}));
import { GET, PATCH } from "./route";

const params = { params: Promise.resolve({ id: "a1" }) };
const patch = (body: unknown) =>
  PATCH(
    new Request("http://localhost/api/operator/accounting/activos/a1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    params,
  );

const current = {
  id: "a1",
  restaurantId: "r1",
  name: "Horno combi",
  code: null,
  purchaseDate: new Date("2026-07-15T00:00:00Z"),
  purchaseCents: 12_000_000,
  salvageCents: 0,
  usefulLifeMonths: 60,
  assetAccountCode: "152005",
  depreciationAccountCode: "159205",
  expenseAccountCode: "516005",
  notes: null,
  active: true,
  disposedAt: null,
  createdAt: new Date("2026-07-15T00:00:00Z"),
};

beforeEach(() => {
  vi.resetAllMocks();
  m.findFirst.mockResolvedValue(current);
  m.update.mockResolvedValue({ ...current });
  m.detail.mockResolvedValue({ asset: { id: "a1" }, posted: [], projected: [] });
});

describe("PATCH /accounting/activos/[id]", () => {
  it("404 si el activo no es del comercio", async () => {
    m.findFirst.mockResolvedValue(null);
    const res = await patch({ name: "Otro" });
    expect(res.status).toBe(404);
    expect(m.findFirst).toHaveBeenCalledWith({ where: { id: "a1", restaurantId: "r1" } });
    expect(m.update).not.toHaveBeenCalled();
  });

  it("400 invalid por forma (campo desconocido o tipo incorrecto)", async () => {
    expect((await patch({ purchaseCents: "doce" })).status).toBe(400);
    expect((await patch({ assetId: "a1", action: "dispose" })).status).toBe(400);
    expect((await patch("{roto")).status).toBe(400);
    expect(m.update).not.toHaveBeenCalled();
  });

  it("400 con el código de la regla: la cuenta de gasto tiene que ser 5xxx", async () => {
    const res = await patch({ expenseAccountCode: "159205" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "expense_account_invalid" });
    expect(m.update).not.toHaveBeenCalled();
  });

  it("valida el conjunto completo: subir el salvamento por encima de la compra actual falla", async () => {
    const res = await patch({ salvageCents: 12_000_000 });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "salvage_too_high" });
  });

  it("mezcla el parche sobre el activo actual y responde 200 con el detalle", async () => {
    const res = await patch({ name: "Horno combi 2", code: "H-01", expenseAccountCode: "516010", notes: "Cocina" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, asset: { id: "a1" }, posted: [], projected: [] });
    expect(m.update).toHaveBeenCalledOnce();
    const { where, data } = m.update.mock.calls[0][0];
    expect(where).toEqual({ id: "a1" });
    expect(data).toMatchObject({
      name: "Horno combi 2",
      code: "H-01",
      purchaseCents: 12_000_000,
      salvageCents: 0,
      usefulLifeMonths: 60,
      assetAccountCode: "152005",
      depreciationAccountCode: "159205",
      expenseAccountCode: "516010",
      notes: "Cocina",
    });
    expect(data.purchaseDate.toISOString()).toBe("2026-07-15T00:00:00.000Z");
    expect(m.detail).toHaveBeenCalledWith("r1", "a1");
  });

  it("code: null borra el código; omitirlo lo conserva", async () => {
    m.findFirst.mockResolvedValue({ ...current, code: "H-01" });
    await patch({ code: null });
    expect(m.update.mock.calls[0][0].data.code).toBeNull();
    await patch({ name: "Otro" });
    expect(m.update.mock.calls[1][0].data.code).toBe("H-01");
  });
});

describe("GET /accounting/activos/[id]", () => {
  it("200 con el detalle; 404 si no existe", async () => {
    const res = await GET(new Request("http://localhost/x"), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ asset: { id: "a1" }, posted: [], projected: [] });
    m.detail.mockResolvedValue(null);
    expect((await GET(new Request("http://localhost/x"), params)).status).toBe(404);
  });
});
