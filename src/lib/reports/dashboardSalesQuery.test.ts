import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ orders: vi.fn(), items: vi.fn(), open: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {
  $queryRaw: m.orders, orderItem: { findMany: m.items }, order: { findMany: m.open },
} }));

import { loadDashboardSales, loadDashboardUncollected } from "./dashboardSalesQuery";

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
  m.open.mockResolvedValue([]);
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

describe("dashboard amount still to collect", () => {
  const BUSINESS_DAY = new Date("2026-10-20T10:00:00Z"); // Bogotá 05:00 cutoff.
  const LIVE_LINES = {
    taxKind: null, cancelledAt: null, qty: { gt: 0 },
    OR: [{ roundId: null }, { round: { status: { not: "cancelled" } } }],
  };
  const openOrder = (id: string, payments: { amountCents: number; tipCents: number }[] = []) => ({
    id, subtotalCents: 3_000_000, taxCents: 0, discountCents: 0, payments,
  });

  it("reads only today's open accounts and their approved payments", async () => {
    expect(await loadDashboardUncollected("tenant", BUSINESS_DAY, INC8)).toEqual({ netCents: 0, orderCount: 0 });
    expect(m.open).toHaveBeenCalledWith({
      where: {
        restaurantId: "tenant",
        status: { in: ["placed", "in_kitchen", "ready", "served", "paying"] },
        // A manual invoice is never an open account of the dining room.
        table: { kind: { not: "manual" } },
        // An account left open from an earlier business day is not today's service.
        createdAt: { gte: BUSINESS_DAY },
      },
      select: {
        id: true, subtotalCents: true, taxCents: true, discountCents: true,
        // A pending cash or card-terminal request has not been collected yet.
        payments: { where: { status: "approved" }, select: { amountCents: true, tipCents: true } },
      },
    });
    expect(m.items).not.toHaveBeenCalled();
  });

  it("adds the unpaid part of each account, with live lines loaded in one batch", async () => {
    m.open.mockResolvedValue([
      openOrder("unpaid"),
      openOrder("split", [{ amountCents: 1_300_000, tipCents: 300_000 }]),
      openOrder("covered", [{ amountCents: 3_000_000, tipCents: 0 }]),
      { ...openOrder("emptied"), subtotalCents: 0 },
    ]);
    m.items.mockResolvedValue([
      { orderId: "unpaid", priceCentsSnapshot: 3_000_000, qty: 1 },
      { orderId: "split", priceCentsSnapshot: 1_500_000, qty: 2 },
      { orderId: "covered", priceCentsSnapshot: 3_000_000, qty: 1 },
    ]);
    expect(await loadDashboardUncollected("tenant", BUSINESS_DAY, INC8)).toEqual({
      netCents: 2_777_778 + 1_851_852, orderCount: 2,
    });
    expect(m.items).toHaveBeenCalledOnce();
    expect(m.items).toHaveBeenCalledWith({
      where: { orderId: { in: ["unpaid", "split", "covered"] }, order: { restaurantId: "tenant" }, ...LIVE_LINES },
      select: { orderId: true, priceCentsSnapshot: true, qty: true },
    });
  });

  it("skips the menu lookup when the merchant has no embedded tax", async () => {
    m.open.mockResolvedValue([openOrder("unpaid"), openOrder("split", [{ amountCents: 1_300_000, tipCents: 300_000 }])]);
    expect(await loadDashboardUncollected("tenant", BUSINESS_DAY, { kind: "none", pct: 0 })).toEqual({
      netCents: 5_000_000, orderCount: 2,
    });
    expect(m.items).not.toHaveBeenCalled();
  });
});
