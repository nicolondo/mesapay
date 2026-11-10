import { describe, expect, it } from "vitest";
import { ordersHref, ordersWhere, parseOrdersView } from "./ordersView";
const today = "2026-11-10";
describe("orders source and table filters", () => {
  it("defaults to all sources and recognizes explicit table/manual selection", () => {
    expect(parseOrdersView({}, today)).toMatchObject({ source: "all", tableId: "" });
    expect(parseOrdersView({ source: "tables", tableId: "table-1" }, today)).toMatchObject({ source: "tables", tableId: "table-1" });
    expect(parseOrdersView({ source: "manual", tableId: "table-1" }, today)).toMatchObject({ source: "manual", tableId: "" });
  });
  it("a specific table implies tables; invalid source does not allow an arbitrary kind", () => {
    expect(parseOrdersView({ tableId: "table-1" }, today)).toMatchObject({ source: "tables", tableId: "table-1" });
    expect(parseOrdersView({ source: "pickup" }, today)).toMatchObject({ source: "all", tableId: "" });
  });
  it("retains unknown table IDs as a restrictive filter", () => {
    const view = parseOrdersView({ source: "tables", tableId: "foreign-table" }, today);
    expect(ordersWhere("r1", view, 5).where).toMatchObject({ restaurantId: "r1", tableId: "foreign-table", table: { kind: "standard", restaurantId: "r1" } });
  });
  it("changing type resets pagination and table while retaining date, query, status and all dates", () => {
    const view = parseOrdersView({ source: "tables", tableId: "t1", page: "4", status: "paid", q: "FE1", fechas: "todas", desde: "2026-11-01", hasta: "2026-11-02" }, today);
    const next = new URL(ordersHref(view, today, { source: "manual" }), "https://example.test").searchParams;
    expect(Object.fromEntries(next)).toEqual({ desde: "2026-11-01", hasta: "2026-11-02", status: "paid", q: "FE1", fechas: "todas", source: "manual" });
  });
  it("preserves table on status/date/search/pagination changes and clears on all sources", () => {
    const view = parseOrdersView({ source: "tables", tableId: "t1", page: "3" }, today);
    expect(ordersHref(view, today, { page: 2 })).toContain("tableId=t1&page=2");
    expect(ordersHref(view, today, { q: "invoice" })).toContain("source=tables&tableId=t1");
    expect(ordersHref(view, today, { source: "all" })).toBe("/operator/orders");
    const picked = parseOrdersView(Object.fromEntries(new URL(ordersHref(view, today, { tableId: "t2" }), "https://example.test").searchParams), today);
    expect(picked).toMatchObject({ source: "tables", tableId: "t2", page: 1 });
  });
  it.each(["tables", "manual"])("applies %s to document matches, the rest and summary counts", (source) => {
    const view = parseOrdersView({ source, q: "7913", status: "paid" }, today);
    const filters = ordersWhere("r1", view, 5, ["document-order"]);
    for (const branch of [filters.where, filters.countWhere, filters.pinned, filters.rest]) expect(branch).toMatchObject({ restaurantId: "r1", table: { restaurantId: "r1", kind: source === "manual" ? "manual" : "standard" } });
    expect(filters.countWhere.status).toBeUndefined(); expect(filters.pinned?.status).toBe("paid");
  });
  it("applies the table id to pinned invoices as well as ordinary codes", () => {
    const filters = ordersWhere("r1", parseOrdersView({ tableId: "t1", q: "7913" }, today), 5, ["document-order"]);
    for (const branch of [filters.where, filters.countWhere, filters.pinned, filters.rest]) expect(branch?.tableId).toBe("t1");
  });
});
