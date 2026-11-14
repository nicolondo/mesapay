import { createElement, Fragment, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  serviceMode: "table",
  uncollected: { netCents: 0, orderCount: 0 },
  loadUncollected: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({ href, className, children }: ComponentProps<"a"> & { href: string }) =>
    createElement("a", { href, className }, children),
}));
// Each key renders as itself; rich text keeps the amount and count inside their tags.
vi.mock("next-intl/server", () => ({
  getTranslations: async () => Object.assign(
    (key: string) => key,
    {
      rich: (key: string, values: {
        amount: string; count: number;
        strong: (chunks: ReactNode) => ReactNode; nowrap: (chunks: ReactNode) => ReactNode;
      }) => createElement(Fragment, null,
        values.strong(`+ ${values.amount}`), ` ${key} `, values.nowrap(String(values.count))),
    },
  ),
  getLocale: async () => "es",
}));
vi.mock("@/lib/activeRestaurant", () => ({ getActiveRestaurantId: async () => "r1" }));
vi.mock("@/lib/db", () => ({ db: {
  restaurant: { findUnique: async () => ({
    name: "Casa", slug: "casa", serviceMode: h.serviceMode, shiftPolicy: null,
    businessDayCutoffHour: 5, salesTaxKind: "inc", salesTaxPct: 8,
  }) },
  order: { count: async () => 3, findMany: async () => [] },
  orderItem: { groupBy: async () => [] },
} }));
vi.mock("@/lib/cashBox", () => ({ buildCashSnapshot: async () => ({}) }));
vi.mock("@/components/CashBox", () => ({ CashBox: () => null }));
vi.mock("./LiveRefresh", () => ({ LiveRefresh: () => null }));
vi.mock("@/lib/reports/dashboardSalesQuery", () => ({
  dashboardOpenOrdersWhere: (restaurantId: string) => ({ restaurantId }),
  // One paid order today: the main figure must stay exactly this.
  loadDashboardSales: async () => [{ paidAt: new Date(), netCents: 9_416_700 }],
  loadDashboardUncollected: h.loadUncollected,
}));

import OperatorHome from "./page";

/** The «Ventas hoy» tile, as rendered. */
async function salesTile() {
  const html = renderToStaticMarkup(await OperatorHome());
  const start = html.indexOf('<a href="/operator/payments"');
  return html.slice(start, html.indexOf("</a>", start));
}

beforeEach(() => {
  h.serviceMode = "table";
  h.loadUncollected.mockReset();
  h.loadUncollected.mockImplementation(async () => h.uncollected);
});

describe("«Ventas hoy» with what is still to collect", () => {
  it("hides the line when nothing is open", async () => {
    h.uncollected = { netCents: 0, orderCount: 0 };
    const tile = await salesTile();
    expect(tile).toContain("$94.167");
    expect(tile).toContain("salesBasis");
    expect(tile).not.toContain("mp-kpi-detail");
  });

  it("adds the amount and the number of tables without changing the main figure", async () => {
    h.uncollected = { netCents: 6_000_000, orderCount: 3 };
    const tile = await salesTile();
    expect(tile).toContain('<span class="mp-kpi-value">$94.167</span>');
    expect(tile).toContain('<span class="mp-kpi-detail-amount">+ $60.000</span> salesUncollectedTables <span class="mp-kpi-detail-nowrap">3</span>');
    // Same basis note, once, after both figures.
    expect(tile.indexOf("mp-kpi-detail")).toBeLessThan(tile.indexOf("salesBasis"));
    expect(tile.match(/salesBasis/g)).toHaveLength(1);
  });

  it("counts orders instead of tables at the counter", async () => {
    h.serviceMode = "counter";
    h.uncollected = { netCents: 6_000_000, orderCount: 1 };
    expect(await salesTile()).toContain("salesUncollectedOrders");
  });

  it("asks only for the current business day, with the merchant's tax", async () => {
    h.uncollected = { netCents: 0, orderCount: 0 };
    await salesTile();
    const [restaurantId, openedSince, tax] = h.loadUncollected.mock.calls[0];
    expect(restaurantId).toBe("r1");
    // 05:00 Bogotá = 10:00 UTC.
    expect((openedSince as Date).toISOString()).toMatch(/T10:00:00\.000Z$/);
    expect(Date.now() - (openedSince as Date).getTime()).toBeLessThan(86_400_000);
    expect(tax).toEqual({ kind: "inc", pct: 8 });
  });
});
