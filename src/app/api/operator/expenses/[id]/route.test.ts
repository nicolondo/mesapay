// Editar un gasto: los impuestos se recalculan en el servidor, la foto de
// «IVA descontable» no se reescribe, no se puede bajar el total a pagar por
// debajo de lo ya abonado, y la cuenta del gasto por fin se guarda.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  restaurantFind: vi.fn(),
  retDelete: vi.fn(),
  retCreate: vi.fn(),
  concepts: vi.fn(),
}));
vi.mock("@/lib/secureApi", () => ({ secureApi: (h: unknown) => h }));
vi.mock("@/lib/erp/access", () => ({
  getErpContext: async () => ({ restaurantId: "r1" }),
  isDenied: () => false,
}));
vi.mock("@/lib/erp/ledger", () => ({
  loadAccountIndex: async () => new Map([["236505", { id: "a", postable: true, active: true }]]),
}));
vi.mock("@/lib/db", () => {
  const tx = {
    expense: { update: m.update },
    expenseRetention: { deleteMany: m.retDelete, createMany: m.retCreate },
  };
  return {
    db: {
      expense: { findUnique: m.findUnique },
      supplier: { findUnique: async () => ({ restaurantId: "r1" }) },
      restaurant: { findUnique: m.restaurantFind },
      retentionConcept: { findMany: m.concepts },
      costCenter: { findFirst: async () => null },
      $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
    },
  };
});

import { PATCH } from "./route";

type Handler = (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>;
const patch = (body: unknown) =>
  (PATCH as unknown as Handler)(
    new Request("http://x/api/operator/expenses/e1", { method: "PATCH", body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: "e1" }) },
  );

const stored = (over: Record<string, unknown> = {}) => ({
  id: "e1",
  restaurantId: "r1",
  category: "Mantenimiento",
  amountCents: 1_000_000,
  baseCents: 1_000_000,
  discountCents: 0,
  ivaPct: 19,
  ivaCents: 190_000,
  ivaDeductible: true,
  incCents: 0,
  payableCents: 1_150_000,
  paidCents: 0,
  paidAt: null,
  date: new Date("2026-10-10T17:00:00Z"),
  documentDate: null,
  supplierId: "s1",
  recurring: false,
  recurringDay: null,
  retentions: [
    { id: "l1", conceptId: "serv", kind: "retefuente", name: "Servicios (4%)", rateBps: 400, base: "subtotal", accountCode: "236505", baseCents: 1_000_000, amountCents: 40_000 },
  ],
  ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  m.findUnique.mockResolvedValue(stored());
  m.update.mockResolvedValue({ id: "e1" });
  m.restaurantFind.mockResolvedValue({ purchaseIvaDeductible: false });
  m.concepts.mockResolvedValue([
    { id: "serv", restaurantId: "r1", kind: "retefuente", name: "Servicios (4%)", rateBps: 400, base: "subtotal", thresholdUvt: 4, accountCode: "236505", active: true },
  ]);
});

describe("PATCH /api/operator/expenses/[id]", () => {
  it("cambiar la base recalcula IVA y total; el IVA descontable guardado se conserva aunque el comercio ya no descuente", async () => {
    const res = await patch({
      subtotalCents: 2_000_000,
      ivaPct: 19,
      ivaCents: null,
      retentions: [{ conceptId: "serv", amountCents: 80_000 }],
    });
    expect(res.status).toBe(200);
    expect(m.update.mock.calls[0]![0].data).toMatchObject({
      amountCents: 2_000_000,
      ivaCents: 380_000,
      ivaDeductible: true,
      retefuenteCents: 80_000,
      payableCents: 2_300_000,
    });
    expect(m.retDelete).toHaveBeenCalledWith({ where: { expenseId: "e1" } });
    expect(m.retCreate.mock.calls[0]![0].data).toEqual([expect.objectContaining({ expenseId: "e1", conceptId: "serv", amountCents: 80_000 })]);
  });

  it("cambiar sólo la categoría no toca montos ni retenciones", async () => {
    await patch({ category: "Reparaciones" });
    const data = m.update.mock.calls[0]![0].data;
    expect(data.category).toBe("Reparaciones");
    expect(data.payableCents).toBeUndefined();
    expect(m.retDelete).not.toHaveBeenCalled();
  });

  it("no se puede bajar el total a pagar por debajo de lo abonado", async () => {
    m.findUnique.mockResolvedValue(stored({ paidCents: 1_150_000, paidAt: new Date("2026-10-10T17:00:00Z") }));
    const res = await patch({ subtotalCents: 500_000, ivaPct: 0, ivaCents: null, retentions: [] });
    expect(await res.json()).toEqual({ error: "below_paid" });
    expect(m.update).not.toHaveBeenCalled();
  });

  it("subir el total de un gasto pagado lo vuelve a dejar con saldo (paidAt → null)", async () => {
    m.findUnique.mockResolvedValue(stored({ paidCents: 1_150_000, paidAt: new Date("2026-10-10T17:00:00Z") }));
    await patch({ subtotalCents: 1_100_000, ivaPct: 19, ivaCents: null, retentions: [{ conceptId: "serv", amountCents: 44_000 }] });
    expect(m.update.mock.calls[0]![0].data).toMatchObject({ payableCents: 1_265_000, paidAt: null });
  });

  it("quitar el proveedor de un gasto con IVA se rechaza", async () => {
    expect(await (await patch({ supplierId: null })).json()).toEqual({ error: "supplier_required" });
  });

  it("un gasto viejo SIN IVA que ahora lo lleva toma la configuración vigente del comercio", async () => {
    m.findUnique.mockResolvedValue(stored({ baseCents: 0, ivaPct: 0, ivaCents: 0, ivaDeductible: false, payableCents: 0, amountCents: 500_000, retentions: [] }));
    m.restaurantFind.mockResolvedValue({ purchaseIvaDeductible: true });
    await patch({ subtotalCents: 500_000, ivaPct: 19, ivaCents: null, retentions: [] });
    expect(m.update.mock.calls[0]![0].data).toMatchObject({ ivaDeductible: true, amountCents: 500_000, payableCents: 595_000 });
  });

  it("la cuenta del gasto y el vencimiento ahora sí se guardan al editar", async () => {
    await patch({ accountCode: "514505", dueAt: "2026-11-30T17:00:00.000Z" });
    expect(m.update.mock.calls[0]![0].data).toMatchObject({ accountCode: "514505", dueAt: new Date("2026-11-30T17:00:00.000Z") });
  });
});
