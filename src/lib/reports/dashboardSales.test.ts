import { describe, expect, it } from "vitest";
import {
  dashboardOrderNetSalesCents,
  summarizeDashboardSales,
  type DashboardSalesOrder,
} from "./dashboardSales";

const INC8 = { kind: "inc" as const, pct: 8 };
const NONE = { kind: "none" as const, pct: 0 };
const order = (overrides: Partial<DashboardSalesOrder> = {}): DashboardSalesOrder => ({
  totalCents: 3_300_000,
  tipCents: 300_000,
  taxCents: 0,
  invoice: { salesTaxKind: "inc", embeddedTaxCents: 222_222 },
  menuItems: [],
  ...overrides,
});

describe("dashboard sales before tips and taxes", () => {
  it("removes the tip and the menu tax frozen in the invoice", () => {
    expect(dashboardOrderNetSalesCents(order(), INC8)).toBe(2_777_778);
  });

  it("removes both embedded INC and on-top IVA in mixed orders", () => {
    expect(dashboardOrderNetSalesCents(order({
      totalCents: 122_000_000,
      tipCents: 300_000,
      taxCents: 19_000_000,
    }), INC8)).toBe(102_477_778);
  });

  it("keeps the discount already reflected in the collected total exactly once", () => {
    // Menu price 30,000 - discount 3,000 + tip 2,700. The fiscal invoice
    // freezes its embedded tax before discount; this report honors it.
    expect(dashboardOrderNetSalesCents(order({ totalCents: 2_970_000, tipCents: 270_000 }), INC8))
      .toBe(2_477_778);
  });

  it("uses historical invoice tax even if the merchant turns taxes off", () => {
    expect(dashboardOrderNetSalesCents(order(), NONE)).toBe(2_777_778);
  });

  it.each([
    {},
    { salesTaxKind: "none", embeddedTaxCents: 222_222 },
    { salesTaxKind: "unexpected", embeddedTaxCents: 222_222 },
  ])("does not apply today's tax to a legacy or untaxed invoice %j", (invoice) => {
    expect(dashboardOrderNetSalesCents(order({ invoice }), INC8)).toBe(3_000_000);
  });

  it.each([null, undefined, "222222", {}, [], -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "does not coerce a malformed frozen tax into money: %j", (embeddedTaxCents) => {
      expect(dashboardOrderNetSalesCents(order({ invoice: { salesTaxKind: "inc", embeddedTaxCents } }), INC8))
        .toBe(3_000_000);
    },
  );

  it("honors IVA snapshots and a zero frozen tax", () => {
    expect(dashboardOrderNetSalesCents(order({ invoice: { salesTaxKind: "iva", embeddedTaxCents: 479_000 } }), INC8))
      .toBe(2_521_000);
    expect(dashboardOrderNetSalesCents(order({ invoice: { salesTaxKind: "inc", embeddedTaxCents: 0 } }), INC8))
      .toBe(3_000_000);
  });

  it("uses current menu tax only when there is no invoice", () => {
    const uninvoiced = order({ invoice: null, menuItems: [{ priceCentsSnapshot: 3_000_000, qty: 1 }] });
    expect(dashboardOrderNetSalesCents(uninvoiced, INC8)).toBe(2_777_778);
    expect(dashboardOrderNetSalesCents(uninvoiced, NONE)).toBe(3_000_000);
  });

  it("splits uninvoiced menu amounts per line with the fiscal rounding", () => {
    const uninvoiced = order({
      totalCents: 6_030, tipCents: 0, invoice: null,
      menuItems: [{ priceCentsSnapshot: 3_015, qty: 1 }, { priceCentsSnapshot: 3_015, qty: 1 }],
    });
    // Each line tax is 223. Aggregating before splitting would give 447.
    expect(dashboardOrderNetSalesCents(uninvoiced, INC8)).toBe(5_584);
  });

  it("multiplies quantities before splitting each menu line", () => {
    expect(dashboardOrderNetSalesCents(order({
      totalCents: 6_030, tipCents: 0, invoice: null,
      menuItems: [{ priceCentsSnapshot: 3_015, qty: 2 }],
    }), INC8)).toBe(5_583);
  });

  it("never reports negative sales for zero-value complimentary or fully discounted orders", () => {
    expect(dashboardOrderNetSalesCents(order({ totalCents: 0, tipCents: 0, invoice: null }), INC8)).toBe(0);
    expect(dashboardOrderNetSalesCents(order({ totalCents: 0, tipCents: 0 }), INC8)).toBe(0);
  });
});

describe("one sales series for daily detail, chart, today's sales and average ticket", () => {
  const from = new Date("2026-10-14T10:00:00.000Z"); // Bogotá 05:00 cutoff.

  it("groups by payment time with the existing business-day cutoff", () => {
    const summary = summarizeDashboardSales([
      { paidAt: new Date("2026-10-14T10:00:00Z"), netCents: 100 },
      { paidAt: new Date("2026-10-18T06:18:00Z"), netCents: 200 },
      { paidAt: new Date("2026-10-20T09:59:59.999Z"), netCents: 300 },
      { paidAt: new Date("2026-10-20T10:00:00Z"), netCents: 101 },
      { paidAt: new Date("2026-10-21T06:18:00Z"), netCents: 100 },
      { paidAt: new Date("2026-10-21T07:00:00Z"), netCents: 0 },
      { paidAt: new Date("2026-10-14T09:59:59.999Z"), netCents: 999_999 },
      { paidAt: new Date("2026-10-21T10:00:00Z"), netCents: 999_999 },
    ], { from, days: 7 });
    expect(summary.days.map((day) => day.netCents)).toEqual([100, 0, 0, 200, 0, 300, 201]);
    expect(summary.days.map((day) => day.paidCount)).toEqual([1, 0, 0, 1, 0, 1, 3]);
    expect(summary).toMatchObject({ totalNetCents: 801, todayNetCents: 201, todayPaidCount: 3, avgTicketNetCents: 67 });
    expect(summary.days[6].date.toISOString()).toBe("2026-10-20T10:00:00.000Z");
    expect(from.toISOString()).toBe("2026-10-14T10:00:00.000Z");
  });

  it("returns all empty days and a zero average without paid orders", () => {
    const summary = summarizeDashboardSales([], { from, days: 7 });
    expect(summary.days).toHaveLength(7);
    expect(summary.days.every((day) => day.netCents === 0 && day.paidCount === 0)).toBe(true);
    expect(summary).toMatchObject({ totalNetCents: 0, todayNetCents: 0, todayPaidCount: 0, avgTicketNetCents: 0 });
  });

  it("rounds the average to the nearest cent", () => {
    const summary = summarizeDashboardSales([
      { paidAt: new Date("2026-10-20T15:00:00Z"), netCents: 100 },
      { paidAt: new Date("2026-10-20T16:00:00Z"), netCents: 101 },
    ], { from, days: 7 });
    expect(summary.avgTicketNetCents).toBe(101);
  });
});
