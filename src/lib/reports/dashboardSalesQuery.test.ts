import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ orders: vi.fn(), items: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { $queryRaw: m.orders, orderItem: { findMany: m.items } } }));

import { loadDashboardSales } from "./dashboardSalesQuery";

const RANGE = { from: new Date("2026-10-14T10:00:00Z"), to: new Date("2026-10-21T10:00:00Z") };
const INC8 = { kind: "inc" as const, pct: 8 };
const paidAt = new Date("2026-10-20T19:00:00Z");
const invoiced = {
  id: "invoiced", paidAt, totalCents: 3_300_000, tipCents: 300_000, taxCents: 0,
  invoiceId: "invoice", salesTaxKind: "inc", embeddedTaxCents: 222_222,
};

beforeEach(() => {
  vi.resetAllMocks();
  m.orders.mockResolvedValue([]);
  m.items.mockResolvedValue([]);
});

describe("dashboard sales loading", () => {
  it("does not load invoice bodies or menu items when frozen invoice tax is available", async () => {
    m.orders.mockResolvedValue([invoiced]);
    expect(await loadDashboardSales("tenant", RANGE, INC8)).toEqual([{ paidAt, netCents: 2_777_778 }]);
    expect(m.items).not.toHaveBeenCalled();
    const query = m.orders.mock.calls[0][0] as { sql: string; values: unknown[] };
    expect(query.values).toEqual(["tenant", RANGE.from, RANGE.to]);
    expect(query.sql).not.toMatch(/SELECT\s+(?:[a-z]+\.)?\*|\bsnapshot\s+AS/i);
  });

  it("loads uninvoiced live menu lines in one batch and assigns each line to its own order", async () => {
    m.orders.mockResolvedValue([
      invoiced,
      { ...invoiced, id: "menu-1", invoiceId: null },
      { ...invoiced, id: "menu-2", invoiceId: null, totalCents: 1_100_000, tipCents: 100_000 },
      { ...invoiced, id: "comp", invoiceId: null, totalCents: 0, tipCents: 0 },
    ]);
    m.items.mockResolvedValue([
      { orderId: "menu-1", priceCentsSnapshot: 1_500_000, qty: 2 },
      { orderId: "menu-2", priceCentsSnapshot: 1_000_000, qty: 1 },
    ]);
    expect(await loadDashboardSales("tenant", RANGE, INC8)).toEqual([
      { paidAt, netCents: 2_777_778 }, { paidAt, netCents: 2_777_778 },
      { paidAt, netCents: 925_926 }, { paidAt, netCents: 0 },
    ]);
    expect(m.items).toHaveBeenCalledOnce();
    expect(m.items).toHaveBeenCalledWith({
      where: {
        orderId: { in: ["menu-1", "menu-2"] }, order: { restaurantId: "tenant" },
        taxKind: null, cancelledAt: null, qty: { gt: 0 },
        OR: [{ roundId: null }, { round: { status: { not: "cancelled" } } }],
      },
      select: { orderId: true, priceCentsSnapshot: true, qty: true },
    });
  });

  it.each([{ kind: "none" as const, pct: 8 }, { kind: "inc" as const, pct: 0 }])(
    "skips menu lookup when the current tax cannot cause embedded tax: %j", async (currentTax) => {
      m.orders.mockResolvedValue([{ ...invoiced, invoiceId: null }]);
      expect(await loadDashboardSales("tenant", RANGE, currentTax)).toEqual([{ paidAt, netCents: 3_000_000 }]);
      expect(m.items).not.toHaveBeenCalled();
    },
  );

  it("does not query menu items for an empty period", async () => {
    expect(await loadDashboardSales("tenant", RANGE, INC8)).toEqual([]);
    expect(m.items).not.toHaveBeenCalled();
  });
});
