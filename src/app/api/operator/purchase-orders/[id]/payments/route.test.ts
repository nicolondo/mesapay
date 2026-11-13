// POST /payments: el abono exige una cuenta de dinero existente en el plan y
// se registra como comprobante de egreso de UNA factura (el servicio de
// «Pagar a proveedor»; su lógica la prueban sus tests y la integración).
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  voucher: vi.fn(),
  findOrder: vi.fn(),
  findPayment: vi.fn(),
}));
vi.mock("@/lib/erp/supplierPaymentService", () => ({ createSupplierPayment: m.voucher }));
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
    purchaseOrder: { findUnique: m.findUnique, findUniqueOrThrow: m.findOrder },
    purchasePayment: { findFirstOrThrow: m.findPayment },
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
  m.findUnique.mockResolvedValue({ restaurantId: "r1", status: "received", supplierId: "s1" });
  m.voucher.mockResolvedValue({ id: "ce-1", number: 7, plan: {} });
  m.findPayment.mockResolvedValue({ id: "pay-1", amountCents: 40000, createdBy: null });
  m.findOrder.mockResolvedValue({ id: "po-1", paidCents: 40000, items: [{ receivedCostCents: 100000, taxPct: 0 }] });
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

  it("registra el abono como comprobante de UNA factura, sin anticipo", async () => {
    const res = await post({ ...base, accountCode: "110505", paidAt: "2026-11-10T17:00:00.000Z" });
    expect(res.status).toBe(201);
    expect(m.voucher).toHaveBeenCalledOnce();
    const [restaurantId, input, userId, opts] = m.voucher.mock.calls[0];
    expect(restaurantId).toBe("r1");
    expect(input).toMatchObject({
      supplierId: "s1",
      date: "2026-11-10",
      accountCode: "110505",
      amountCents: 40000,
      docs: [{ kind: "purchase", id: "po-1" }],
      credits: [],
    });
    expect(userId).toBe("user-1");
    expect(opts).toBeUndefined();
    expect(await res.json()).toMatchObject({ voucher: { number: 7 }, totalCents: 100000, paidCents: 40000, outstandingCents: 60000 });
  });

  it("una OC sin recibir no tiene cuenta por pagar", async () => {
    m.findUnique.mockResolvedValue({ restaurantId: "r1", status: "sent", supplierId: "s1" });
    const res = await post({ ...base, accountCode: "110505" });
    expect(res.status).toBe(409);
    expect(m.voucher).not.toHaveBeenCalled();
  });

  it("sigue rechazando un abono mayor al saldo", async () => {
    const { SupplierCreditError } = await import("@/lib/erp/supplierCreditNoteService");
    m.voucher.mockRejectedValue(new SupplierCreditError("exceeds_balance", 400));
    const res = await post({ ...base, amountCents: 100001, accountCode: "110505" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "exceeds_balance" });
  });
});
