import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Corte de bonos usados: agrupa sólo lo que no entró en un corte
 * anterior, arma el link de pago sólo por lo redimido de lotes a
 * crédito, y el rango de días se interpreta en hora Bogotá.
 */
const m = vi.hoisted(() => ({
  customerFindFirst: vi.fn(),
  restaurantFindUniqueOrThrow: vi.fn(),
  redemptionFindMany: vi.fn(),
  redemptionUpdateMany: vi.fn(),
  statementCreate: vi.fn(),
  linkCreate: vi.fn(),
  executeRaw: vi.fn(),
  currency: vi.fn(),
}));

const tx = {
  $executeRaw: m.executeRaw,
  voucherRedemption: { findMany: m.redemptionFindMany, updateMany: m.redemptionUpdateMany },
  voucherStatement: { create: m.statementCreate },
  paymentLink: { create: m.linkCreate },
};

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    billingCustomer: { findFirst: m.customerFindFirst },
    restaurant: { findUniqueOrThrow: m.restaurantFindUniqueOrThrow },
    voucherRedemption: { findMany: m.redemptionFindMany },
  },
}));
vi.mock("@/lib/billing/countries", () => ({ getCurrencyForCountry: m.currency }));
vi.mock("./statementEmail", () => ({ sendVoucherStatementEmail: vi.fn() }));

import { closeVoucherStatement, dayRange, parseDayStart } from "./statement";

const credit = (id: string, amountCents: number) => ({ id, amountCents, voucher: { batch: { mode: "credit" } } });
const prepaid = (id: string, amountCents: number) => ({ id, amountCents, voucher: { batch: { mode: "prepaid" } } });

const range = dayRange("2026-09-01", "2026-09-15")!;
const close = () =>
  closeVoucherStatement({
    restaurantId: "rest-1",
    billingCustomerId: "cust-1",
    from: range.from,
    to: range.to,
    userId: "user-1",
  });

beforeEach(() => {
  vi.resetAllMocks();
  m.customerFindFirst.mockResolvedValue({ id: "cust-1" });
  m.restaurantFindUniqueOrThrow.mockResolvedValue({ country: "CO" });
  m.currency.mockResolvedValue("COP");
  m.statementCreate.mockResolvedValue({ id: "st-1" });
  m.redemptionUpdateMany.mockResolvedValue({ count: 3 });
  m.linkCreate.mockResolvedValue({ id: "link-1", token: "tok-st" });
  m.executeRaw.mockResolvedValue(0);
});

describe("rango de días (Bogotá)", () => {
  it("un día empieza a las 00:00 de Bogotá (05:00 UTC) y el fin es exclusivo", () => {
    expect(parseDayStart("2026-09-01")?.toISOString()).toBe("2026-09-01T05:00:00.000Z");
    expect(range.from.toISOString()).toBe("2026-09-01T05:00:00.000Z");
    expect(range.to.toISOString()).toBe("2026-09-16T05:00:00.000Z");
  });
  it("rechaza fechas rotas o invertidas", () => {
    expect(parseDayStart("2026-9-1")).toBeNull();
    expect(dayRange("2026-09-15", "2026-09-01")).toBeNull();
    expect(dayRange(null, "2026-09-01")).toBeNull();
  });
});

describe("closeVoucherStatement", () => {
  it("agrupa SÓLO lo sin corte de esa empresa en el rango, y el link cobra lo de crédito", async () => {
    m.redemptionFindMany.mockResolvedValue([credit("r1", 300_000_00), credit("r2", 120_000_00), prepaid("r3", 300_000_00)]);
    const r = await close();
    expect(r).toEqual({
      ok: true,
      statementId: "st-1",
      totalCents: 720_000_00,
      creditCents: 420_000_00,
      count: 3,
      paymentLinkToken: "tok-st",
    });
    expect(m.redemptionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          restaurantId: "rest-1",
          statementId: null,
          redeemedAt: { gte: range.from, lt: range.to },
          voucher: { batch: { billingCustomerId: "cust-1" } },
        }),
      }),
    );
    expect(m.statementCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        restaurantId: "rest-1",
        billingCustomerId: "cust-1",
        totalCents: 720_000_00,
        creditCents: 420_000_00,
        prepaidCents: 300_000_00,
        redemptionCount: 3,
        status: "open",
        createdByUserId: "user-1",
      }),
    });
    expect(m.redemptionUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ["r1", "r2", "r3"] } },
      data: { statementId: "st-1" },
    });
    expect(m.linkCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: "voucher_statement",
        amountCents: 420_000_00,
        currency: "COP",
        voucherStatementId: "st-1",
      }),
    });
  });

  it("sólo bonos prepagados: el corte nace pagado y no hay link", async () => {
    m.redemptionFindMany.mockResolvedValue([prepaid("r1", 100_00), prepaid("r2", 200_00)]);
    const r = await close();
    expect(r).toMatchObject({ ok: true, creditCents: 0, totalCents: 300_00, paymentLinkToken: null });
    expect(m.statementCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: "paid", prepaidCents: 300_00, creditCents: 0 }),
    });
    expect(m.linkCreate).not.toHaveBeenCalled();
  });

  it("sin usos pendientes no crea nada (cerrar dos veces el mismo rango es inocuo)", async () => {
    m.redemptionFindMany.mockResolvedValue([]);
    expect(await close()).toEqual({ ok: false, error: "nothing_to_close" });
    expect(m.statementCreate).not.toHaveBeenCalled();
  });

  it("la empresa de otro comercio no existe", async () => {
    m.customerFindFirst.mockResolvedValue(null);
    expect(await close()).toEqual({ ok: false, error: "customer_not_found" });
    expect(m.redemptionFindMany).not.toHaveBeenCalled();
  });
});
