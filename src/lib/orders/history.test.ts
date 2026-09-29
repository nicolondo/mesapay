import { describe, expect, it } from "vitest";
import { historyDate, historyQueries, mergeHistory } from "./history";

const opened = new Date("2026-09-28T16:00:00Z");
const paid = new Date("2026-09-29T18:00:00Z");
describe("order sales history uses payment time", () => {
  it("uses final settlement for paid orders and opening for unpaid legacy orders", () => {
    expect(historyDate({ createdAt: opened, paidAt: paid })).toBe(paid);
    expect(historyDate({ createdAt: opened, paidAt: null })).toBe(opened);
  });
  it("filters and sorts both bounded streams by their displayed date", () => {
    const since = new Date("2026-09-29T05:00:00Z");
    const queries = historyQueries({ restaurantId: "restaurant", status: "paid", shortCode: { contains: "ABC" } }, since);
    expect(queries).toEqual([
      { where: { restaurantId: "restaurant", status: "paid", shortCode: { contains: "ABC" }, paidAt: { gte: since } }, orderBy: [{ paidAt: "desc" }, { id: "desc" }], take: 100 },
      { where: { restaurantId: "restaurant", status: "paid", shortCode: { contains: "ABC" }, paidAt: null, createdAt: { gte: since } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100 },
    ]);
  });
  it("all-time keeps non-null and null payment streams disjoint", () => {
    const queries = historyQueries({ restaurantId: "r" }, null);
    expect(queries[0].where.paidAt).toEqual({ not: null });
    expect(queries[1].where.paidAt).toBeNull();
    expect(queries[1].where.createdAt).toBeUndefined();
  });
  it("merges before limiting and leaves its input immutable", () => {
    const paidOrder = { id: "a", createdAt: opened, paidAt: paid };
    const openOrder = { id: "b", createdAt: new Date("2026-09-29T17:00:00Z"), paidAt: null };
    const input = [openOrder, paidOrder];
    expect(mergeHistory(input, 1)).toEqual([paidOrder]);
    expect(input).toEqual([openOrder, paidOrder]);
  });
  it("breaks equal time ties by id for deterministic results", () => {
    expect(mergeHistory([{ id: "a", createdAt: opened, paidAt: null }, { id: "b", createdAt: opened, paidAt: null }]).map(r => r.id)).toEqual(["b", "a"]);
  });
});


it("keeps only the latest 100 across paid and opening timestamps", () => {
  const rows = Array.from({ length: 200 }, (_, index) => ({
    id: String(index),
    createdAt: new Date(index * 1000),
    paidAt: index < 100 ? new Date((index + 500) * 1000) : null,
  }));
  const result = mergeHistory(rows);
  expect(result).toHaveLength(100);
  expect(result[0].id).toBe("99");
  expect(result[99].id).toBe("0");
});
