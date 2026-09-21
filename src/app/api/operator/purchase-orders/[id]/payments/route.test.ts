// POST /payments: el abono exige una cuenta de dinero existente en el plan.
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
}));
vi.mock("@/lib/secureApi", () => ({ secureApi: (h: unknown) => h }));
vi.mock("@/auth", () => ({
  auth: async () => ({ user: { id: "user-1", role: "operator" } }),
}));
vi.mock("@/lib/erp/access", () => ({
  getErpContext: async () => ({ restaurantId: "r1" }),
  isDenied: () => false,
}));
vi.mock("@/lib/erp/ledger", () => ({
  loadAccountMap: async () =>
    new Map([
      ["110505", "acc-caja"],
      ["111005", "acc-banco"],
      ["220505", "acc-proveedores"],
    ]),
}));
vi.mock("@/lib/db", () => ({
  db: {
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        purchaseOrder: { findUnique: m.findUnique, update: m.update },
        purchasePayment: { create: m.create },
      }),
  },
}));
import { POST } from "./route";

const post = (body: Record<string, unknown>) =>
  POST(
    new Request("http://localhost/api/operator/purchase-orders/po-1/payments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "po-1" }) },
  );

const base = { amountCents: 40000, paidAt: null, note: null };

beforeEach(() => {
  vi.resetAllMocks();
  m.findUnique.mockResolvedValue({
    restaurantId: "r1",
    status: "received",
    paidCents: 0,
    items: [{ receivedCostCents: 100000, taxPct: 0 }],
  });
  m.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "pay-1",
    ...data,
    createdBy: null,
  }));
  m.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "po-1",
    ...data,
  }));
});

describe("POST /purchase-orders/[id]/payments", () => {
  it("rechaza el abono sin cuenta de origen", async () => {
    const res = await post(base);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid" });
    expect(m.create).not.toHaveBeenCalled();
  });

  it("rechaza una cuenta que no existe en el plan", async () => {
    const res = await post({ ...base, accountCode: "119999" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "account_invalid" });
    expect(m.create).not.toHaveBeenCalled();
  });

  it("rechaza una cuenta que existe pero no es de dinero (proveedores)", async () => {
    const res = await post({ ...base, accountCode: "220505" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "account_invalid" });
    expect(m.create).not.toHaveBeenCalled();
  });

  it("registra el abono con la cuenta elegida", async () => {
    const res = await post({ ...base, accountCode: "110505" });
    expect(res.status).toBe(201);
    expect(m.create).toHaveBeenCalledOnce();
    expect(m.create.mock.calls[0][0].data).toMatchObject({
      restaurantId: "r1",
      purchaseOrderId: "po-1",
      amountCents: 40000,
      accountCode: "110505",
      method: null,
      createdById: "user-1",
    });
    const body = await res.json();
    expect(body).toMatchObject({
      totalCents: 100000,
      paidCents: 40000,
      outstandingCents: 60000,
    });
    // Sigue debiendo: la OC no queda marcada como pagada.
    expect(m.update.mock.calls[0][0].data).toMatchObject({ paidCents: 40000, paidAt: null });
  });

  it("marca la OC pagada cuando el abono cubre el saldo", async () => {
    const res = await post({ ...base, amountCents: 100000, accountCode: "111005" });
    expect(res.status).toBe(201);
    expect(m.update.mock.calls[0][0].data.paidCents).toBe(100000);
    expect(m.update.mock.calls[0][0].data.paidAt).toBeInstanceOf(Date);
  });

  it("sigue rechazando un abono mayor al saldo", async () => {
    const res = await post({ ...base, amountCents: 100001, accountCode: "110505" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "exceeds_balance" });
  });
});
