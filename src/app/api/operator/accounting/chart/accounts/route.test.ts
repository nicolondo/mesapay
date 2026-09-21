// POST /accounts: alta de una cuenta con las reglas del plan (createAccount
// real sobre una DB mockeada): 201 con traslado, 400 por validación, 409
// por código repetido.
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  findMany: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  lineUpdateMany: vi.fn(),
  refUpdateMany: vi.fn(),
}));
vi.mock("@/lib/secureApi", () => ({ secureApi: (h: unknown) => h }));
vi.mock("@/auth", () => ({
  auth: async () => ({ user: { id: "user-1", role: "operator" } }),
}));
vi.mock("@/lib/erp/access", () => ({
  getErpContext: async () => ({ restaurantId: "r1" }),
  isDenied: () => false,
}));
vi.mock("@/lib/db", () => ({
  db: {
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        ledgerAccount: { findMany: m.findMany, create: m.create, update: m.update },
        journalLine: { updateMany: m.lineUpdateMany },
        expense: { updateMany: m.refUpdateMany },
        expensePayment: { updateMany: m.refUpdateMany },
        purchasePayment: { updateMany: m.refUpdateMany },
        retentionConcept: { updateMany: m.refUpdateMany },
        bankRecRule: { updateMany: m.refUpdateMany },
        budget: { updateMany: m.refUpdateMany },
        fixedAsset: { updateMany: m.refUpdateMany },
      }),
  },
}));
import { POST } from "./route";

const post = (body: unknown) =>
  POST(
    new Request("http://localhost/api/operator/accounting/chart/accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const row = (code: string, over: Record<string, unknown> = {}) => ({
  id: `id-${code}`,
  code,
  name: `Cuenta ${code}`,
  type: "activo",
  nature: "debito",
  level: code.length,
  parentCode: code.length > 1 ? code.slice(0, code.length === 2 ? 1 : code.length - 2) : null,
  postable: code.length >= 6,
  active: true,
  ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  m.findMany.mockResolvedValue([row("1"), row("11"), row("1110"), row("111005")]);
  m.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "id-new",
    ...data,
  }));
  m.lineUpdateMany.mockResolvedValue({ count: 4 });
  m.refUpdateMany.mockResolvedValue({ count: 0 });
});

describe("POST /accounting/chart/accounts", () => {
  it("rechaza un cuerpo inválido", async () => {
    const res = await post({ code: "11100501" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid" });
    expect(m.create).not.toHaveBeenCalled();
  });

  it("crea la auxiliar y reporta las líneas trasladadas desde la madre", async () => {
    const res = await post({ code: "11100501", name: "Bancolombia ahorros", parentCode: "111005" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      transferredLines: 4,
      account: {
        code: "11100501",
        name: "Bancolombia ahorros",
        type: "activo",
        nature: "debito",
        level: 8,
        parentCode: "111005",
        postable: true,
        active: true,
      },
    });
    expect(m.lineUpdateMany).toHaveBeenCalledWith({
      where: { accountId: "id-111005" },
      data: { accountId: "id-new", accountCode: "11100501" },
    });
    expect(m.update).toHaveBeenCalledWith({ where: { id: "id-111005" }, data: { postable: false } });
  });

  it("400 con el código del error cuando el código no cuelga de la madre", async () => {
    const res = await post({ code: "11050501", name: "Caja menor", parentCode: "111005" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_prefix" });
    expect(m.create).not.toHaveBeenCalled();
  });

  it("409 cuando el código ya existe", async () => {
    const res = await post({ code: "111005", name: "Bancos", parentCode: "1110" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "code_taken" });
    expect(m.create).not.toHaveBeenCalled();
  });
});
