import { createElement, type ComponentProps, type ReactNode } from "react";
import { renderToReadableStream, renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  open: false,
  pathname: "/operator/settings/insumos",
  links: [] as { href: string; prefetch: boolean | null | undefined }[],
  orderFindMany: vi.fn(),
}));

// Render the open drawer/dropdown branches without a browser. Other state,
// including pathname and input values, keeps its normal initial value.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => actual.useState(h.open && initial === false ? true : initial),
  };
});
vi.mock("next/link", () => ({
  default: ({ href, prefetch, children, ...props }: ComponentProps<"a"> & {
    href: string;
    prefetch?: boolean | null;
  }) => {
    h.links.push({ href, prefetch });
    return createElement("a", { href, ...props }, children);
  },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => h.pathname,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  redirect: (url: string) => { throw new Error(`redirect:${url}`); },
}));
vi.mock("next/headers", () => ({ cookies: async () => ({
  get: (name: string) => name === "mp_shell" ? { value: "classic" } : undefined,
}) }));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
  getLocale: async () => "es",
}));
vi.mock("@/auth", () => ({
  auth: async () => ({ user: { role: "platform_admin", email: "test@example.invalid" } }),
  signOut: vi.fn(),
}));
vi.mock("@/lib/activeRestaurant", () => ({
  IMPERSONATE_COOKIE: "test-restaurant",
  getActiveContext: async () => ({ restaurantId: "r1", impersonating: false }),
  getActiveRestaurantId: async () => "r1",
}));
vi.mock("@/lib/db", () => ({ db: {
  restaurant: { findUnique: async () => ({
    name: "Test restaurant", slug: "test", hasBar: true, serviceMode: "table",
    enabledModules: ["inventory"], suspended: false, adminOnlyCharge: false,
  }) },
  order: {
    findMany: h.orderFindMany,
    count: async () => 2,
    aggregate: async () => ({ _avg: { totalCents: 0 }, _sum: { totalCents: 0 } }),
  },
  orderItem: { groupBy: async () => [] },
} }));
vi.mock("@/lib/membership", () => ({ deriveMembershipStatus: () => "activo" }));
vi.mock("./boardActivity", () => ({ computeBoardActivity: async () => ({ kitchen: 0, bar: 0, floor: 0 }) }));
vi.mock("./GroupSwitcher", () => ({ GroupSwitcher: () => null }));
vi.mock("./BillRequestAlert", () => ({ BillRequestAlert: () => null }));
vi.mock("@/components/LocaleSwitcher", () => ({ LocaleSwitcher: () => null }));
vi.mock("@/components/CashBox", () => ({ CashBox: () => null }));
vi.mock("@/lib/cashBox", () => ({ buildCashSnapshot: async () => ({}) }));
vi.mock("./LiveRefresh", () => ({ LiveRefresh: () => null }));
vi.mock("@/components/ui/AppDialog", () => ({ AppDialog: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/app/mesero/PushSetup", () => ({ PushSetup: () => null }));

import { OperatorCockpit } from "./OperatorCockpit";
import { OperatorMobileMenu, type NavEntry } from "./OperatorMobileMenu";
import { NavDropdown } from "./NavDropdown";
import OperatorLayout from "./layout";
import MeseroLayout from "@/app/mesero/layout";
import OperatorHome from "./page";
import OrdersPage from "./orders/page";
import { BarSubTabs } from "./bar/BarSubTabs";
import { MesasGrid } from "./tables/MesasGrid";
import { TableDetailSheet } from "./tables/TableDetailSheet";

const navItems: NavEntry[] = [
  { href: "/operator", label: "Summary" },
  { href: "/operator/kitchen", label: "Kitchen" },
  { href: "/operator/bar", label: "Bar" },
  { href: "/operator/serve", label: "Floor" },
  { href: "/operator/tables", label: "Tables" },
  { label: "Inventory", children: [
    { href: "/operator/settings/insumos", label: "Ingredients" },
    { href: "/operator/inventario", label: "Stock" },
  ] },
];

function expectNavigationOnly(html: string, expectedHrefs: string[]) {
  expect(h.links.map(link => link.href)).toEqual(expect.arrayContaining(expectedHrefs));
  expect(h.links.length).toBeGreaterThan(0);
  for (const link of h.links) {
    expect(link.prefetch, `Background fetch must be disabled for ${link.href}`).toBe(false);
    expect(html).toContain(`href="${link.href.replaceAll("&", "&amp;")}"`);
  }
}

beforeEach(() => {
  h.open = false;
  h.pathname = "/operator/settings/insumos";
  h.links = [];
  vi.stubGlobal("localStorage", { getItem: () => null });
  h.orderFindMany.mockReset();
  h.orderFindMany.mockImplementation(async (args: { select?: { paidAt?: boolean } }) => args.select?.paidAt ? [] : [{
    id: "order-1", shortCode: "ABC123", status: "placed", createdAt: new Date("2026-10-14T12:00:00Z"),
    paidAt: null, subtotalCents: 1000, totalCents: 1000, discountCents: 0,
    table: { number: 1, kind: "regular" }, items: [{ qty: 1 }], payments: [], simpleInvoice: null,
  }]);
});
afterEach(() => vi.unstubAllGlobals());

describe("staff navigation does not refetch every visible route on live refresh", () => {
  it("keeps cockpit board, group, admin and quick-action destinations navigable", () => {
    h.open = true;
    // eslint-disable-next-line react/no-children-prop -- Required by the component's props type.
    const html = renderToStaticMarkup(createElement(OperatorCockpit, {
      navItems, roleLabel: "Admin", tenantName: "Test", userEmail: "test@example.invalid",
      isAdmin: true, localeSwitcher: null, signOut: null, banners: null, children: null,
    }));
    expectNavigationOnly(html, ["/operator", "/operator/kitchen", "/operator/bar", "/operator/serve",
      "/operator/tables", "/operator/settings/insumos", "/operator/inventario", "/operator/reports", "/admin"]);
    expect(html).toContain('aria-current="page"');
  });

  it("keeps the classic desktop links and admin destination navigable", async () => {
    const html = renderToStaticMarkup(await OperatorLayout({ children: null }));
    expectNavigationOnly(html, ["/operator", "/operator/kitchen", "/operator/bar", "/operator/serve", "/admin"]);
  });

  it("keeps every open mobile drawer destination navigable", () => {
    h.open = true;
    const html = renderToStaticMarkup(createElement(OperatorMobileMenu, {
      tenantName: "Test", userEmail: "test@example.invalid", isAdmin: true,
      items: navItems, signOutAction: null,
    }));
    expectNavigationOnly(html, ["/operator/tables", "/operator/kitchen", "/operator/settings/insumos", "/admin"]);
  });

  it("keeps open desktop dropdown destinations navigable", () => {
    h.open = true;
    const html = renderToStaticMarkup(createElement(NavDropdown, {
      label: "Inventory", items: [
        { href: "/operator/settings/insumos", label: "Ingredients" },
        { href: "/operator/inventario", label: "Stock" },
      ],
    }));
    expectNavigationOnly(html, ["/operator/settings/insumos", "/operator/inventario"]);
    expect(html).toContain('role="menuitem"');
  });

  it("keeps all waiter bottom tabs navigable", async () => {
    const html = renderToStaticMarkup(await MeseroLayout({ children: null }));
    expectNavigationOnly(html, ["/mesero/mesas", "/mesero/salon", "/mesero/yo"]);
  });

  it("does not prefetch dashboard KPI, order-row or menu destinations on each update", async () => {
    const html = renderToStaticMarkup(await OperatorHome());
    expectNavigationOnly(html, ["/operator/tables", "/operator/menu", "/operator/kitchen",
      "/operator/payments", "/operator/orders?status=paid", "/operator/reports", "/operator/orders/order-1"]);
  });

  it("does not prefetch history filters or every order detail on each update", async () => {
    const stream = await renderToReadableStream(await OrdersPage({ searchParams: Promise.resolve({ period: "all" }) }));
    await stream.allReady;
    const html = await new Response(stream).text();
    expectNavigationOnly(html, ["/operator/orders/order-1", "/operator/orders?period=all&q=&status=open"]);
  });

  it.each(["/bar", "/operator/bar"])("keeps %s substation destinations on the authorized board", pathname => {
    h.pathname = pathname;
    const html = renderToStaticMarkup(createElement(BarSubTabs, {
      subStations: ["Cold drinks"], activeSub: "Cold drinks", allLabel: "All",
    }));
    expectNavigationOnly(html, [pathname, `${pathname}?sub=Cold%20drinks`]);
  });

  it.each([false, true])("does not download a full menu for each free/recent table (waiter=%s)", isMeseroView => {
    const html = renderToStaticMarkup(createElement(MesasGrid, {
      initialTime: Date.parse("2026-10-14T12:00:00Z"),
      tiles: [
        { id: "free", number: 1, label: null, qrToken: "qr-free", state: "free" },
        { id: "recent", number: 2, label: null, qrToken: "qr-recent", state: "recently_paid", paidAt: "2026-10-14T11:59:00Z" },
      ],
      tenantSlug: "test", counterMode: false, isMeseroView, manualTiles: [], canOpenManual: false,
      chargeLocked: false, moveLocked: false, compPolicy: { locked: false, allowedRoles: ["operator"] },
      viewerRole: isMeseroView ? "mesero" : "operator", freeTables: [], allTables: [], country: "CO", salesTax: null,
    }));
    expectNavigationOnly(html, isMeseroView
      ? ["/mesero/pedir/free", "/mesero/pedir/recent"]
      : ["/t/test/menu?table=qr-free&op=1", "/t/test/menu?table=qr-recent&op=1"]);
    if (!isMeseroView) expect(html).toContain('target="_blank"');
  });

  it("does not prefetch menu, charging or prebill from an open waiter table", () => {
    const html = renderToStaticMarkup(createElement(TableDetailSheet, {
      orderId: "order-1", shortCode: "ABC123", tableLabel: "Table 1", tableNumber: 1,
      tableId: "table-1", freeTables: [], allTables: [], open: true, hideTrigger: true,
      orderStatus: "served", outstandingCents: 1000, tenantSlug: "test", qrToken: "qr-table-1",
      isMeseroView: true, chargeLocked: false, moveLocked: false, viewerRole: "mesero",
      compPolicy: { locked: true, allowedRoles: ["operator"] },
      initialRounds: [{ id: "round", seq: 1, status: "ready", placedAt: "2026-10-14T12:00:00Z",
        placedByName: null, placedByRole: null, items: [{ id: "item", menuItemId: "dish", name: "Dish", qty: 1,
          priceCents: 1000, kitchenStatus: "ready", preparationStartedAt: null, preparationFirstStartedAt: null,
          servedAt: "2026-10-14T12:10:00Z", expediteRequestedAt: null, guestName: null, notes: null }] }],
    }));
    expectNavigationOnly(html, ["/mesero/pedir/table-1", "/mesero/cobrar/order-1", "/mesero/precuenta/order-1"]);
  });
});
