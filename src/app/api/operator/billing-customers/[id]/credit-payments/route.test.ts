// Abonos de clientes: alta (201), validaciones (monto > deuda, cuenta que
// no es de dinero, rol) y reversa (DELETE) con el scope en el where.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  active: vi.fn(),
  accounts: vi.fn(),
  customerFindFirst: vi.fn(),
  paymentFindMany: vi.fn(),
  abonoFindMany: vi.fn(),
  abonoCreate: vi.fn(),
  abonoDeleteMany: vi.fn(),
  queryRaw: vi.fn(async () => []),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/activeRestaurant", () => ({ getActiveRestaurantId: m.active }));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/lib/erp/paymentAccounts", () => ({ listMoneyAccounts: m.accounts }));
vi.mock("@/lib/db", () => {
  const client = {
    billingCustomer: { findFirst: m.customerFindFirst },
    payment: { findMany: m.paymentFindMany },
    customerCreditPayment: { findMany: m.abonoFindMany, create: m.abonoCreate, deleteMany: m.abonoDeleteMany },
    $queryRaw: m.queryRaw,
  };
  return { db: { ...client, $transaction: async (fn: (tx: typeof client) => unknown) => fn(client) } };
});

import { POST } from "./route";
import { DELETE } from "./[paymentId]/route";

const post = (body: unknown) =>
  POST(
    new Request("http://localhost/api/operator/billing-customers/cust-1/credit-payments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "cust-1" }) },
  );
const del = () =>
  DELETE(new Request("http://localhost/x", { method: "DELETE" }), {
    params: Promise.resolve({ id: "cust-1", paymentId: "abono-9" }),
  });

const charge = (id: string, amountCents: number, date: string) => ({
  id,
  settledAt: new Date(date),
  createdAt: new Date(date),
  amountCents,
  tipCents: 0,
  refundedCents: 0,
  orderId: `o-${id}`,
  order: { shortCode: id.toUpperCase(), table: null },
});

beforeEach(() => {
  vi.clearAllMocks();
  m.auth.mockResolvedValue({ user: { id: "user-1", role: "operator" } });
  m.active.mockResolvedValue("r1");
  m.accounts.mockResolvedValue([{ code: "110505", name: "Caja general" }, { code: "111005", name: "Bancos" }]);
  m.customerFindFirst.mockResolvedValue({ id: "cust-1", creditEnabled: true, creditLimitCents: null, creditTermsDays: 30 });
  m.paymentFindMany.mockResolvedValue([charge("c1", 100_000, "2026-09-01"), charge("c2", 50_000, "2026-09-05")]);
  m.abonoFindMany.mockResolvedValue([]);
  m.abonoCreate.mockImplementation(async (args: { data: Record<string, unknown> }) => ({ id: "abono-1", ...args.data }));
  m.abonoDeleteMany.mockResolvedValue({ count: 1 });
});

describe("POST abono", () => {
  it("registra el abono con la cuenta de origen y la fecha al mediodía UTC", async () => {
    const res = await post({ amountCents: 60_000, paidAt: "2026-09-10", accountCode: "111005", note: "Transferencia" });
    expect(res.status).toBe(201);
    expect(m.abonoCreate).toHaveBeenCalledWith({
      data: {
        restaurantId: "r1",
        billingCustomerId: "cust-1",
        amountCents: 60_000,
        paidAt: new Date("2026-09-10T12:00:00.000Z"),
        accountCode: "111005",
        note: "Transferencia",
        createdById: "user-1",
      },
    });
    expect(await res.json()).toEqual({ payment: { id: "abono-1" }, debtAfterCents: 90_000 });
    // Serializa por cliente: lock de la fila antes de leer la deuda.
    expect(m.queryRaw).toHaveBeenCalled();
  });

  it("sin fecha usa hoy", async () => {
    const before = Date.now();
    await post({ amountCents: 1_000, accountCode: "110505" });
    const paidAt = m.abonoCreate.mock.calls[0][0].data.paidAt as Date;
    expect(paidAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("no acepta un abono mayor que la deuda", async () => {
    m.abonoFindMany.mockResolvedValue([{ id: "a0", paidAt: new Date("2026-09-06"), amountCents: 100_000, accountCode: "110505", note: null, createdBy: null }]);
    const res = await post({ amountCents: 50_001, accountCode: "110505" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "exceeds_debt", debtCents: 50_000 });
    expect(m.abonoCreate).not.toHaveBeenCalled();
  });

  it("rechaza una cuenta que no es de dinero del plan", async () => {
    const res = await post({ amountCents: 1_000, accountCode: "130505" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "account_invalid" });
  });

  it("valida el cuerpo (monto entero positivo, fecha yyyy-mm-dd)", async () => {
    expect((await post({ amountCents: 0, accountCode: "110505" })).status).toBe(400);
    expect((await post({ amountCents: 1_000, accountCode: "110505", paidAt: "10/09/2026" })).status).toBe(400);
    expect((await post({ amountCents: 1_000, accountCode: "110505", paidAt: "2026-02-31" })).status).toBe(400);
  });

  it("cliente de otro comercio → 404", async () => {
    m.customerFindFirst.mockResolvedValue(null);
    expect((await post({ amountCents: 1_000, accountCode: "110505" })).status).toBe(404);
  });

  it("el mesero no registra abonos", async () => {
    m.auth.mockResolvedValue({ user: { id: "w", role: "mesero" } });
    expect((await post({ amountCents: 1_000, accountCode: "110505" })).status).toBe(401);
    expect((await del()).status).toBe(401);
  });
});

describe("DELETE abono", () => {
  it("borra sólo dentro del cliente y del comercio", async () => {
    const res = await del();
    expect(res.status).toBe(200);
    expect(m.abonoDeleteMany).toHaveBeenCalledWith({
      where: { id: "abono-9", billingCustomerId: "cust-1", restaurantId: "r1" },
    });
  });
  it("un abono ajeno no existe", async () => {
    m.abonoDeleteMany.mockResolvedValue({ count: 0 });
    expect((await del()).status).toBe(404);
  });
});
