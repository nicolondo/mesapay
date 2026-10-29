import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

const m = vi.hoisted(() => ({ paymentFindMany: vi.fn(), queryRaw: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { payment: { findMany: m.paymentFindMany }, $queryRaw: m.queryRaw } }));
import { loadShiftConsumptionTax, loadShiftPaymentSummaries } from "./shiftConsumptionTaxQuery";

const time = new Date("2026-10-28T18:00:00Z");
const invoice = { orderId: "order", totalCents: 3, fiscal: { totalCents: 3, tipCents: 0, salesTaxKind: "inc", embeddedTaxCents: 1 } };
const payments = ["a", "b", "c"].map((id) => ({ id, orderId: "order", amountCents: 1, tipCents: 0, settledAt: time, createdAt: time }));
const t = (consumptionTaxCents: number, taxPendingPayments = 0) => ({ consumptionTaxCents, taxPendingPayments });
beforeEach(() => {
  vi.resetAllMocks();
  m.paymentFindMany.mockResolvedValue(payments);
  m.queryRaw.mockResolvedValue([invoice]);
});

describe("batched shift consumption tax projection", () => {
  it("does no queries for empty selections or empty shift histories", async () => {
    expect(await loadShiftConsumptionTax("tenant", [])).toEqual(new Map());
    expect(await loadShiftPaymentSummaries("tenant", [])).toEqual(new Map());
    expect(m.paymentFindMany).not.toHaveBeenCalled();
    expect(m.queryRaw).not.toHaveBeenCalled();
  });

  it("loads original approved/refunded settlements in one scope and projects fiscal JSON only", async () => {
    const rows = await loadShiftConsumptionTax("tenant", [payments[0], payments[2]]);
    expect([...rows]).toEqual([["a", t(0)], ["c", t(0)]]);
    expect(m.paymentFindMany).toHaveBeenCalledExactlyOnceWith({
      where: { orderId: { in: ["order"] }, order: { restaurantId: "tenant" }, status: { in: ["approved", "refunded"] } },
      select: { id: true, orderId: true, amountCents: true, tipCents: true, settledAt: true, createdAt: true },
    });
    expect(m.queryRaw).toHaveBeenCalledTimes(1);
    const query = m.queryRaw.mock.calls[0][0] as Prisma.Sql;
    expect(query.values).toEqual(["tenant", "order"]);
    expect(query.sql).toContain('o."restaurantId" = i."restaurantId"');
    expect(query.sql).toContain("field.key IN ('totalCents', 'tipCents', 'taxCents', 'taxByKind',");
    expect(query.sql).toContain("'salesTaxKind', 'embeddedTaxCents'");
    expect(query.sql).not.toMatch(/SELECT\s+i\."snapshot"|email|customer|items/);
  });

  it("keeps pending amounts explicit when a tenant payment or invoice is unavailable", async () => {
    m.queryRaw.mockResolvedValue([]);
    const rows = await loadShiftConsumptionTax("tenant", [payments[0], { id: "foreign", orderId: "foreign-order" }]);
    expect([...rows]).toEqual([["a", t(0, 1)], ["foreign", t(0, 1)]]);
    expect(m.paymentFindMany.mock.calls[0][0].where.order).toEqual({ restaurantId: "tenant" });
  });

  it("uses one selection and one fiscal batch for all global and personal windows", async () => {
    const selected = payments.map((p, index) => ({ ...p, shiftId: index < 2 ? "global" : null, collectedByUserId: "waiter" }));
    m.paymentFindMany.mockResolvedValueOnce(selected).mockResolvedValueOnce(payments);
    const shifts = [
      { id: "global", userId: null, openedAt: time, closedAt: null },
      { id: "personal", userId: "waiter", openedAt: time, closedAt: time },
      { id: "empty", userId: "waiter", openedAt: new Date(time.getTime() + 1), closedAt: null },
    ];
    const rows = await loadShiftPaymentSummaries("tenant", shifts);
    expect(rows.get("global")).toEqual({ ...t(1), grossCents: 2, tipCents: 0, paymentCount: 2 });
    expect(rows.get("personal")).toEqual({ ...t(1), grossCents: 3, tipCents: 0, paymentCount: 3 });
    expect(rows.get("empty")).toEqual({ ...t(0), grossCents: 0, tipCents: 0, paymentCount: 0 });
    expect(m.paymentFindMany).toHaveBeenCalledTimes(2);
    expect(m.queryRaw).toHaveBeenCalledTimes(1);
    expect(m.paymentFindMany.mock.calls[0][0].where).toEqual({
      order: { restaurantId: "tenant" }, status: "approved", OR: [
        { collectedByUserId: "waiter", settledAt: { gte: time, lte: time } },
        { collectedByUserId: "waiter", settledAt: { gte: new Date(time.getTime() + 1) } },
        { shiftId: { in: ["global"] } },
      ],
    });
  });

  it("retains global payments without settlement timestamps, excluding them from personal windows", async () => {
    m.paymentFindMany.mockResolvedValueOnce(payments.map((p) => ({ ...p, shiftId: "global", collectedByUserId: "waiter", settledAt: null })));
    const rows = await loadShiftPaymentSummaries("tenant", [
      { id: "global", userId: null, openedAt: time, closedAt: time },
      { id: "personal", userId: "waiter", openedAt: time, closedAt: time },
    ]);
    expect(rows.get("global")).toEqual({ ...t(1), grossCents: 3, tipCents: 0, paymentCount: 3 });
    expect(rows.get("personal")).toEqual({ ...t(0), grossCents: 0, tipCents: 0, paymentCount: 0 });
  });

  it("returns zero for empty windows without fetching fiscal JSON", async () => {
    m.paymentFindMany.mockResolvedValue([]);
    const rows = await loadShiftPaymentSummaries("tenant", [{ id: "global", userId: null, openedAt: time, closedAt: time }]);
    expect(rows.get("global")).toEqual({ ...t(0), grossCents: 0, tipCents: 0, paymentCount: 0 });
    expect(m.paymentFindMany).toHaveBeenCalledTimes(1);
    expect(m.queryRaw).not.toHaveBeenCalled();
  });
});
