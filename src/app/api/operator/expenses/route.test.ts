// Crear un gasto: el servidor recalcula impuestos y retenciones (nunca le
// cree al cliente la tarifa ni la cuenta), guarda la foto de «IVA
// descontable» del comercio y, si se pagó de contado, el abono es por el
// TOTAL A PAGAR (lo retenido se le debe a la DIAN, no sale de caja).
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  expenseCreate: vi.fn(),
  expenseFind: vi.fn(),
  paymentCreate: vi.fn(),
  supplierFind: vi.fn(),
  restaurantFind: vi.fn(),
  concepts: vi.fn(),
  accounts: new Map<string, string>([["111005", "acc-banco"]]),
}));
vi.mock("@/lib/secureApi", () => ({ secureApi: (h: unknown) => h }));
vi.mock("@/auth", () => ({ auth: async () => ({ user: { id: "u1" } }) }));
vi.mock("@/lib/erp/access", () => ({
  getErpContext: async () => ({ restaurantId: "r1", country: "CO" }),
  isDenied: () => false,
}));
vi.mock("@/lib/erp/ledger", () => ({
  loadAccountMap: async () => m.accounts,
  loadAccountIndex: async () =>
    new Map(["236505", "236705", "236805"].map((c) => [c, { id: c, postable: true, active: true }])),
}));
vi.mock("@/lib/db", () => {
  const tx = {
    expense: { create: m.expenseCreate, findUnique: m.expenseFind },
    expensePayment: { create: m.paymentCreate },
  };
  return {
    db: {
      supplier: { findUnique: m.supplierFind },
      restaurant: { findUnique: m.restaurantFind },
      retentionConcept: { findMany: m.concepts },
      costCenter: { findFirst: async () => null },
      $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
    },
  };
});

import { POST } from "./route";

const post = (body: unknown) =>
  (POST as unknown as (r: Request) => Promise<Response>)(
    new Request("http://x/api/operator/expenses", { method: "POST", body: JSON.stringify(body) }),
  );

const BASE = { category: "Mantenimiento nevera", date: "2026-10-10T17:00:00.000Z" };

beforeEach(() => {
  vi.resetAllMocks();
  m.restaurantFind.mockResolvedValue({ purchaseIvaDeductible: true });
  m.supplierFind.mockResolvedValue({ restaurantId: "r1" });
  m.expenseCreate.mockResolvedValue({ id: "e1" });
  m.expenseFind.mockResolvedValue({ id: "e1" });
  m.paymentCreate.mockResolvedValue({ id: "p1" });
  m.concepts.mockResolvedValue([
    { id: "serv", restaurantId: "r1", kind: "retefuente", name: "Servicios (4%)", rateBps: 400, base: "subtotal", thresholdUvt: 4, accountCode: "236505", active: true },
  ]);
});

describe("POST /api/operator/expenses", () => {
  it("gasto simple (formulario viejo, sólo monto): base = costo = total a pagar, como siempre", async () => {
    const res = await post({ ...BASE, amountCents: 250_000, payFromAccountCode: "111005" });
    expect(res.status).toBe(201);
    expect(m.expenseCreate.mock.calls[0]![0].data).toMatchObject({
      amountCents: 250_000,
      baseCents: 250_000,
      ivaCents: 0,
      payableCents: 250_000,
      paidCents: 250_000,
      documentType: "none",
    });
    expect(m.expenseCreate.mock.calls[0]![0].data.retentions).toBeUndefined();
    expect(m.paymentCreate.mock.calls[0]![0].data).toMatchObject({ amountCents: 250_000, accountCode: "111005" });
  });

  it("factura con IVA descontable y retefuente: guarda costo, IVA, retención del concepto y paga el total a pagar", async () => {
    const res = await post({
      ...BASE,
      supplierId: "s1",
      subtotalCents: 1_000_000,
      ivaPct: 19,
      retentions: [{ conceptId: "serv", amountCents: 40_000 }],
      documentType: "e_invoice",
      documentNumber: " FE-901 ",
      documentDate: "2026-10-08T17:00:00.000Z",
      attachmentUrl: "/uploads/gasto-0123456789abcdef.pdf",
      payFromAccountCode: "111005",
    });
    expect(res.status).toBe(201);
    const data = m.expenseCreate.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      amountCents: 1_000_000,
      baseCents: 1_000_000,
      ivaPct: 19,
      ivaCents: 190_000,
      ivaDeductible: true,
      retefuenteCents: 40_000,
      payableCents: 1_150_000,
      paidCents: 1_150_000,
      documentType: "e_invoice",
      documentNumber: "FE-901",
      attachmentUrl: "/uploads/gasto-0123456789abcdef.pdf",
    });
    expect(data.retentions.create).toEqual([
      expect.objectContaining({ conceptId: "serv", kind: "retefuente", rateBps: 400, accountCode: "236505", baseCents: 1_000_000, amountCents: 40_000 }),
    ]);
    expect(m.paymentCreate.mock.calls[0]![0].data.amountCents).toBe(1_150_000);
  });

  it("comercio que NO descuenta IVA: el IVA es costo del gasto (foto en el gasto)", async () => {
    m.restaurantFind.mockResolvedValue({ purchaseIvaDeductible: false });
    await post({ ...BASE, supplierId: "s1", subtotalCents: 1_000_000, ivaPct: 19 });
    expect(m.expenseCreate.mock.calls[0]![0].data).toMatchObject({ amountCents: 1_190_000, ivaDeductible: false, payableCents: 1_190_000, paidCents: 0 });
  });

  it("con IVA o retenciones exige proveedor; sin monto, sin cuenta de pago válida o con un concepto ajeno, rechaza", async () => {
    expect(await (await post({ ...BASE, subtotalCents: 100_000, ivaPct: 19 })).json()).toEqual({ error: "supplier_required" });
    expect((await post({ ...BASE })).status).toBe(400);
    expect(await (await post({ ...BASE, amountCents: 1_000, payFromAccountCode: "119999" })).json()).toEqual({ error: "account_not_found" });
    m.concepts.mockResolvedValue([]);
    expect(
      await (await post({ ...BASE, supplierId: "s1", subtotalCents: 100_000, retentions: [{ conceptId: "otro", amountCents: 1 }] })).json(),
    ).toEqual({ error: "retention_not_found" });
    expect(m.expenseCreate).not.toHaveBeenCalled();
  });

  it("la plantilla recurrente guarda su configuración de impuestos pero no se paga", async () => {
    await post({ ...BASE, supplierId: "s1", subtotalCents: 1_000_000, ivaPct: 19, recurring: true, recurringDay: 5, payFromAccountCode: "111005" });
    expect(m.expenseCreate.mock.calls[0]![0].data).toMatchObject({ recurring: true, recurringDay: 5, ivaCents: 190_000, paidCents: 0 });
    expect(m.paymentCreate).not.toHaveBeenCalled();
  });
});
