import { describe, it, expect } from "vitest";
import { aggregateTrend, type PaidOrder } from "./revenueTrend";

const rows: PaidOrder[] = [
  { paidAt: new Date("2026-03-01T15:00:00Z"), totalCents: 10000 },
  { paidAt: new Date("2026-03-01T18:00:00Z"), totalCents: 5000 },
  { paidAt: new Date("2026-03-02T15:00:00Z"), totalCents: 20000 },
];

describe("aggregateTrend", () => {
  it("agrupa por día y calcula crecimiento punta a punta", () => {
    const r = aggregateTrend(rows, { bucket: "day", timezone: "America/Bogota" });
    expect(r.points).toEqual([
      { period: "2026-03-01", revenueCents: 15000, orders: 2 },
      { period: "2026-03-02", revenueCents: 20000, orders: 1 },
    ]);
    expect(r.growthPct).toBe(33); // 15000 → 20000
  });
});
