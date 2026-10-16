import { describe, expect, it } from "vitest";
import { parseServiceReportFilters, serviceReportHref, serviceReportSearchParams } from "./serviceAdjustments";

const now = new Date("2026-10-14T08:00:00Z");
const parse = (query: Record<string, string | string[] | undefined> = {}, cutoff = 5) =>
  parseServiceReportFilters("uncollected", query, cutoff, now);

describe("service report filters", () => {
  it("uses seven business dates including today, before the restaurant cutoff", () => {
    const result = parse();
    expect(result).toMatchObject({ desde: "2026-10-07", hasta: "2026-10-13", page: 1, pageSize: 50, view: "items" });
    expect(result.start?.toISOString()).toBe("2026-10-07T10:00:00.000Z");
    expect(result.end?.toISOString()).toBe("2026-10-14T10:00:00.000Z");
  });
  it.each([
    ["today", "2026-10-13"], ["30d", "2026-09-14"], ["month", "2026-10-01"],
  ])("resolves the %s preset", (range, desde) => expect(parse({ range }).desde).toBe(desde));
  it("offers all recorded history without a hidden date cap", () => {
    expect(parse({ range: "all" })).toMatchObject({ start: null, end: null, desde: null, hasta: null });
  });
  it("validates both custom dates and uses an exclusive upper business boundary", () => {
    const result = parse({ desde: "2024-02-29", hasta: "2024-03-01" });
    expect(result.range).toBe("custom");
    expect(result.end?.toISOString()).toBe("2024-03-02T10:00:00.000Z");
  });
  it.each([
    { desde: "2026-02-30", hasta: "2026-03-01" }, { desde: "2026-10-15", hasta: "2026-10-14" },
    { desde: "2026-10-01" }, { range: "invalid" }, { page: "0" }, { page: "1.2" },
    { page: "1000001" }, { kind: "paid" }, { vista: "bad" }, { q: "a".repeat(161) },
    { email: "a".repeat(255) }, { range: ["today", "all"] }, { format: "exe" },
    { orderId: "x".repeat(129) }, { desde: "1999-01-01", hasta: "2026-01-01" },
    { range: "custom" },
  ])("rejects malformed inputs instead of displaying misleading totals: %j", (input) => {
    expect(() => parse(input)).toThrow("invalid_report_filters");
  });
  it("trims text, accepts export, and sets representation view defaults", () => {
    const result = parseServiceReportFilters("representation", { email: " staff@example.test ", q: " mesa 1 ", format: "csv" }, 0, now);
    expect(result).toMatchObject({ view: "orders", kind: "representation", email: "staff@example.test", q: "mesa 1" });
    expect(parseServiceReportFilters("representation", { vista: "productos" }, 0, now).view).toBe("items");
  });
  it("preserves filters in links and explicitly clears them with null", () => {
    const result = parse({ range: "all", kind: "comp", email: "a+b@example.test", q: "agua & sal", page: "3", orderId: "order-1" });
    const url = new URL(serviceReportHref(result, { email: null, q: null, kind: "all", orderId: null, page: 1 }), "https://example.test");
    expect(url.pathname).toBe("/operator/reports/no-cobrados");
    expect([...url.searchParams]).toEqual([["range", "all"]]);
    expect(serviceReportSearchParams(result).get("email")).toBe("a+b@example.test");
  });
  it("serializes custom dates, view and page for representation drilldown", () => {
    const result = parseServiceReportFilters("representation", { desde: "2026-10-01", hasta: "2026-10-14", vista: "productos", page: "2" }, 0, now);
    expect(serviceReportHref(result)).toBe("/operator/reports/gastos-representacion?desde=2026-10-01&hasta=2026-10-14&vista=productos&page=2");
  });
  it("sanitizes an invalid configuration cutoff to midnight", () => {
    expect(parse({ range: "today" }, 99).start?.toISOString()).toBe("2026-10-14T05:00:00.000Z");
  });
});
