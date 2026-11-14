// Registrar el pago de un gasto que quedó debiéndose: la pantalla de gastos
// ahora usa esta ruta (antes no la usaba ninguna y el gasto quedaba en
// cuentas por pagar para siempre).
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  findUnique: vi.fn(),
  voucher: vi.fn(),
  update: vi.fn(),
  paymentCreate: vi.fn(),
}));
vi.mock("@/lib/secureApi", () => ({ secureApi: (h: unknown) => h }));
vi.mock("@/auth", () => ({ auth: async () => ({ user: { id: "u1" } }) }));
vi.mock("@/lib/erp/access", () => ({
  getErpContext: async () => ({ restaurantId: "r1" }),
  isDenied: () => false,
}));
vi.mock("@/lib/erp/ledger", () => ({ loadAccountMap: async () => new Map([["110505", "acc-caja"]]) }));
vi.mock("@/lib/db", () => {
  const tx = {
    expense: { findUnique: m.findUnique, update: m.update },
    expensePayment: { create: m.paymentCreate },
  };
  return {
    db: {
      $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
      // Con proveedor el abono es un comprobante de egreso (ver el último caso).
      expense: { findUnique: m.findUnique, findUniqueOrThrow: async () => ({ id: "e1" }) },
      expensePayment: { findFirstOrThrow: async () => ({ id: "p-ce" }) },
    },
  };
});
vi.mock("@/lib/erp/supplierPaymentService", () => ({ createSupplierPayment: m.voucher }));

import { POST } from "./route";
import { expenseOutstandingCents } from "@/lib/erp/accounting";

type Handler = (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>;
const pay = (body: unknown) =>
  (POST as unknown as Handler)(
    new Request("http://x/api/operator/expenses/e1/payments", { method: "POST", body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: "e1" }) },
  );

beforeEach(() => {
  vi.resetAllMocks();
  m.findUnique.mockResolvedValue({ restaurantId: "r1", amountCents: 500_000, paidCents: 200_000, recurring: false });
  m.paymentCreate.mockResolvedValue({ id: "p1" });
  m.update.mockResolvedValue({ id: "e1" });
});

describe("POST /api/operator/expenses/[id]/payments", () => {
  it("el pago del saldo deja el gasto pagado en la fecha elegida y con la cuenta de donde salió", async () => {
    const res = await pay({ amountCents: 300_000, paidAt: "2026-10-20T17:00:00.000Z", accountCode: "110505" });
    expect(res.status).toBe(201);
    expect(m.paymentCreate.mock.calls[0]![0].data).toMatchObject({
      expenseId: "e1",
      amountCents: 300_000,
      accountCode: "110505",
      paidAt: new Date("2026-10-20T17:00:00.000Z"),
    });
    expect(m.update.mock.calls[0]![0].data).toEqual({
      paidCents: 500_000,
      paidAt: new Date("2026-10-20T17:00:00.000Z"),
    });
  });

  it("con impuestos, el saldo es el TOTAL A PAGAR (lo retenido no se le paga al proveedor)", async () => {
    // Costo $10.000 + IVA descontable $1.900 − retefuente $400 = $11.500 a pagar.
    m.findUnique.mockResolvedValue({ restaurantId: "r1", amountCents: 1_000_000, payableCents: 1_150_000, paidCents: 0, recurring: false });
    expect((await pay({ amountCents: 1_150_001, accountCode: "110505" })).status).toBe(400);
    const res = await pay({ amountCents: 1_150_000, paidAt: "2026-10-21T17:00:00.000Z", accountCode: "110505" });
    expect(res.status).toBe(201);
    expect(m.update.mock.calls[0]![0].data).toEqual({ paidCents: 1_150_000, paidAt: new Date("2026-10-21T17:00:00.000Z") });
  });

  it("rechaza un pago mayor que el saldo y una cuenta que no está en el plan", async () => {
    expect((await pay({ amountCents: 300_001, accountCode: "110505" })).status).toBe(400);
    const res = await pay({ amountCents: 1_000, accountCode: "999999" });
    expect(await res.json()).toEqual({ error: "account_not_found" });
    expect(m.paymentCreate).not.toHaveBeenCalled();
  });
});

describe("expenseOutstandingCents", () => {
  it("monto − abonado; las plantillas no tienen saldo", () => {
    expect(expenseOutstandingCents({ amountCents: 500_000, paidCents: 200_000, recurring: false })).toBe(300_000);
    expect(expenseOutstandingCents({ amountCents: 500_000, paidCents: null, recurring: false })).toBe(500_000);
    expect(expenseOutstandingCents({ amountCents: 500_000, paidCents: 600_000, recurring: false })).toBe(0);
    expect(expenseOutstandingCents({ amountCents: 500_000, recurring: true })).toBe(0);
  });

  it("con proveedor, el abono es un comprobante de egreso de esa factura (cualquier cuenta del plan)", async () => {
    m.findUnique.mockResolvedValue({ restaurantId: "r1", supplierId: "s1", recurring: false, amountCents: 500_000, paidCents: 0 });
    m.voucher.mockResolvedValue({ id: "ce-1", number: 3, plan: {} });
    const res = await pay({ amountCents: 100_000, accountCode: "110505", paidAt: "2026-10-21T17:00:00.000Z" });
    expect(res.status).toBe(201);
    const [, input, , opts] = m.voucher.mock.calls[0]!;
    expect(input).toMatchObject({ supplierId: "s1", date: "2026-10-21", docs: [{ kind: "expense", id: "e1" }], credits: [] });
    expect(opts).toEqual({ anyAccount: true });
    expect(m.paymentCreate).not.toHaveBeenCalled();
  });
});
