import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceReportRow, ServiceReportResult } from "./serviceAdjustments";

const m = vi.hoisted(() => ({
  auth: vi.fn(), activeContext: vi.fn(), activeRestaurant: vi.fn(), restaurant: vi.fn(),
  report: vi.fn(), rows: vi.fn(), rate: vi.fn(), currency: vi.fn(), locale: vi.fn(), translations: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/db", () => ({ db: { restaurant: { findUnique: m.restaurant } } }));
vi.mock("@/lib/activeRestaurant", () => ({ getActiveContext: m.activeContext, getActiveRestaurantId: m.activeRestaurant }));
vi.mock("@/lib/guestAccess", () => ({ canAccessOrder: vi.fn(), canAccessTable: vi.fn() }));
vi.mock("@/lib/rateLimit", () => ({ rateLimit: m.rate }));
vi.mock("@/lib/billing/countries", () => ({ getCurrencyForCountry: m.currency }));
vi.mock("@/lib/reports/serviceAdjustmentsQuery", () => ({ getServiceReport: m.report, iterateServiceReportRows: m.rows }));
vi.mock("next-intl/server", () => ({ getLocale: m.locale, getTranslations: m.translations }));

import { GET as uncollected } from "@/app/api/operator/reports/no-cobrados/route";
import { GET as representation } from "@/app/api/operator/reports/gastos-representacion/route";

const row: ServiceReportRow = {
  id: "row-1", eventAt: new Date("2026-10-13T18:00:00Z"), orderId: "order-1", shortCode: "ABC-123",
  tableNumber: 4, tableLabel: null, name: "Historical dish", kind: "item_comp", reason: null, actorEmail: null,
  quantity: 3, lineCount: 1, amountCents: 120000, detailAmountCents: 120000, missingDetail: false,
};
const result: ServiceReportResult = {
  rows: [row], totals: { rowCount: 1, orderCount: 1, lineCount: 1, quantity: 3, amountCents: 120000,
    unknownAmountCount: 0, cancelAmountCents: 0, compAmountCents: 120000, representationAmountCents: 0 },
  page: 1, pageSize: 50, pageCount: 1,
};
const request = (query = "", report = "no-cobrados") => new Request(`http://localhost/api/operator/reports/${report}${query}`);

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-14T08:00:00Z"));
  m.auth.mockResolvedValue({ user: { role: "operator", id: "admin-1" } });
  m.activeContext.mockResolvedValue({ restaurantId: "restaurant-1", session: { user: { role: "operator", id: "admin-1" } } });
  m.activeRestaurant.mockResolvedValue("restaurant-1");
  m.restaurant.mockResolvedValue({ country: "MX", enabledModules: [], businessDayCutoffHour: 5 });
  m.report.mockResolvedValue(result);
  m.rows.mockImplementation(async function* () { yield row; });
  m.rate.mockResolvedValue(true); m.currency.mockResolvedValue("MXN"); m.locale.mockResolvedValue("en");
  m.translations.mockResolvedValue((key: string, values?: Record<string, unknown>) => values?.currency ? `${key}:${values.currency}` : key);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("service report JSON API", () => {
  it("returns all totals and pagination with currency and business-date filter metadata", async () => {
    const response = await uncollected(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toContain("Cookie");
    expect(response.headers.get("x-request-id")).toBeTruthy();
    const body = await response.json();
    expect(body).toMatchObject({
      currency: "MXN", totals: result.totals, pageSize: 50, pageCount: 1,
      filters: { report: "uncollected", desde: "2026-10-07", hasta: "2026-10-13", page: 1,
        start: "2026-10-07T10:00:00.000Z", end: "2026-10-14T10:00:00.000Z" },
    });
    expect(m.report).toHaveBeenCalledWith("restaurant-1", expect.objectContaining({ start: new Date("2026-10-07T10:00:00Z") }));
    expect(m.currency).toHaveBeenCalledWith("MX");
    expect(m.restaurant).toHaveBeenCalledWith({ where: { id: "restaurant-1" }, select: { businessDayCutoffHour: true } });
  });

  it("supports representation without an accounting module and ignores a caller-supplied tenant", async () => {
    const response = await representation(request("?range=all&vista=productos&email=staff%40example.test&orderId=foreign&restaurantId=other&page=4", "gastos-representacion"));
    expect(response.status).toBe(200);
    expect(m.report).toHaveBeenCalledWith("restaurant-1", expect.objectContaining({
      report: "representation", view: "items", kind: "representation", start: null, end: null,
      email: "staff@example.test", orderId: "foreign", page: 4,
    }));
    expect(m.rows).not.toHaveBeenCalled();
  });

  it.each(["operator", "group_admin", "platform_admin"])("allows the administrative role %s", async (role) => {
    m.auth.mockResolvedValue({ user: { role, id: "admin-1" } });
    expect((await uncollected(request())).status).toBe(200);
  });

  it.each(["waiter", "kitchen", "diner"])("blocks %s before querying report data", async (role) => {
    m.auth.mockResolvedValue({ user: { role, id: "staff-1" } });
    const response = await uncollected(request());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(m.report).not.toHaveBeenCalled(); expect(m.rows).not.toHaveBeenCalled();
    expect(m.restaurant).not.toHaveBeenCalled();
  });

  it("keeps the secureApi boundary for unauthenticated operator requests", async () => {
    m.activeContext.mockResolvedValue(null);
    const response = await uncollected(request());
    expect(response.status).toBe(401);
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(m.auth).not.toHaveBeenCalled(); expect(m.report).not.toHaveBeenCalled();
  });

  it.each([
    "?range=today&range=all", "?q=a&q=b", "?format=csv&format=json", "?unused=a&unused=b",
    "?desde=2026-02-30&hasta=2026-03-01", "?desde=2026-10-14", "?range=unknown", "?page=-1",
    "?page=1.5", "?kind=paid", "?vista=unknown", "?format=xlsx",
  ])("rejects malformed or duplicate parameters: %s", async (query) => {
    const response = await uncollected(request(query));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_report_filters" });
    expect(m.report).not.toHaveBeenCalled(); expect(m.rows).not.toHaveBeenCalled();
  });

  it("returns a safe error if the active restaurant disappears before loading its cutoff", async () => {
    m.restaurant.mockResolvedValueOnce({ country: "MX", enabledModules: [] }).mockResolvedValueOnce(null);
    const response = await uncollected(request());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "no_restaurant" });
    expect(m.report).not.toHaveBeenCalled();
  });

  it("bounds JSON work per authenticated user and fails closed when the limit is exhausted", async () => {
    m.rate.mockResolvedValue(false);
    const response = await uncollected(request());
    expect(m.rate).toHaveBeenCalledWith("service-reports:read:restaurant-1:admin-1", 120, 60);
    expect(response.status).toBe(429); expect(response.headers.get("retry-after")).toBe("60");
    expect(await response.json()).toEqual({ error: "rate_limited" });
    expect(m.report).not.toHaveBeenCalled();
  });
});

describe("service report CSV API", () => {
  it("uses the same filters and authenticated tenant, while exporting all pages", async () => {
    const response = await uncollected(request("?format=csv&range=all&kind=comp&email=admin%40example.test&q=dish&page=8"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toContain("no-cobrados-all.csv");
    expect(m.rows).toHaveBeenCalledWith("restaurant-1", expect.objectContaining({
      report: "uncollected", kind: "comp", email: "admin@example.test", q: "dish", page: 1, start: null, end: null,
    }));
    expect(m.report).not.toHaveBeenCalled();
    expect(m.translations).toHaveBeenCalledWith("serviceReports");
    const csv = await response.text();
    expect(csv).toContain("csvAmount:MXN"); expect(csv).toContain("Historical dish");
    expect(csv).toContain(";3;1;1200,00;1200,00;noActor;noReason;");
  });

  it("uses a representation filename with the requested date bounds", async () => {
    const response = await representation(request("?format=csv&desde=2026-10-01&hasta=2026-10-14", "gastos-representacion"));
    expect(response.headers.get("content-disposition")).toContain("gastos-representacion-2026-10-01-2026-10-14.csv");
    expect(m.rows).toHaveBeenCalledWith("restaurant-1", expect.objectContaining({ report: "representation", view: "orders" }));
    await response.text();
  });

  it("limits exports across users in the restaurant before starting a database iterator", async () => {
    m.rate.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const response = await uncollected(request("?format=csv"));
    expect(m.rate).toHaveBeenLastCalledWith("service-reports:export:restaurant-1", 30, 60);
    expect(response.status).toBe(429);
    expect(m.rows).not.toHaveBeenCalled();
  });

  it("returns a non-cacheable 500 with no internal database detail if the first batch fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    m.rows.mockImplementation(async function* () { throw new Error("private_database_detail"); });
    const response = await uncollected(request("?format=csv"));
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ error: "internal_error" });
  });
});
