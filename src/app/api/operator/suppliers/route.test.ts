// Alta de proveedor (la usan Ajustes › Proveedores y el alta rápida del
// gasto): con tipo de documento el NIT se guarda con su DV calculado, un DV
// que no corresponde se rechaza, y un nombre o un documento repetido
// devuelve el proveedor existente para ofrecer usarlo.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  gate: [] as string[][],
  findUnique: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
}));
vi.mock("@/lib/secureApi", () => ({ secureApi: (h: unknown) => h }));
vi.mock("@/lib/erp/access", () => ({
  getErpContext: async (gate: string[]) => {
    m.gate.push(gate);
    return { restaurantId: "r1", country: "CO" };
  },
  isDenied: () => false,
}));
vi.mock("@/lib/db", () => ({
  db: { supplier: { findUnique: m.findUnique, findMany: m.findMany, create: m.create } },
}));

import { POST } from "./route";

const post = (body: unknown) =>
  (POST as unknown as (r: Request) => Promise<Response>)(
    new Request("http://x/api/operator/suppliers", { method: "POST", body: JSON.stringify(body) }),
  );

beforeEach(() => {
  vi.resetAllMocks();
  m.gate = [];
  m.findUnique.mockResolvedValue(null);
  m.findMany.mockResolvedValue([]);
  m.create.mockImplementation(async (args: { data: Record<string, unknown> }) => ({ id: "s-new", ...args.data }));
});

describe("POST /api/operator/suppliers", () => {
  it("se abre con compras O contabilidad (el gasto crea su proveedor sin el módulo de compras)", async () => {
    await post({ name: "Refrigeración Andina" });
    expect(m.gate[0]).toEqual(["purchasing", "accounting"]);
  });

  it("NIT: guarda número-DV calculado, el tipo de documento y el de persona", async () => {
    const res = await post({ name: "Refrigeración Andina", taxId: "901.944.469", taxIdType: "NIT", personType: "juridica" });
    expect(res.status).toBe(201);
    expect(m.create.mock.calls[0]![0].data).toMatchObject({
      name: "Refrigeración Andina",
      taxId: "901944469-1",
      taxIdType: "NIT",
      personType: "juridica",
    });
  });

  it("un DV escrito que no corresponde se rechaza", async () => {
    const res = await post({ name: "X", taxId: "901944469-7", taxIdType: "NIT" });
    expect(await res.json()).toEqual({ error: "invalid_verification_digit" });
    expect(m.create).not.toHaveBeenCalled();
  });

  it("mismo documento (aunque se escriba distinto) → 409 con el proveedor existente", async () => {
    m.findMany.mockResolvedValue([{ id: "s1", name: "Andina SAS", taxId: "901944469-1", active: true }]);
    const res = await post({ name: "Refrigeración Andina", taxId: "901944469", taxIdType: "NIT" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "tax_id_taken", existing: { id: "s1", name: "Andina SAS", taxId: "901944469-1", active: true } });
    expect(m.create).not.toHaveBeenCalled();
  });

  it("mismo nombre → 409 con el existente; sin tipo de documento el texto libre queda como siempre", async () => {
    m.findUnique.mockResolvedValueOnce({ id: "s2", name: "Gas Natural", taxId: null, active: true });
    const dup = await post({ name: "Gas Natural" });
    expect(await dup.json()).toMatchObject({ error: "name_taken", existing: { id: "s2" } });
    await post({ name: "Otro", taxId: "NIT 800.123.456" });
    expect(m.create.mock.calls[0]![0].data).toMatchObject({ taxId: "NIT 800.123.456", taxIdType: null });
  });
});
