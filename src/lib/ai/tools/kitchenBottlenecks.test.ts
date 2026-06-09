import { describe, it, expect } from "vitest";
import { aggregateBottlenecks, type PrepRow } from "./kitchenBottlenecks";

const rows: PrepRow[] = [
  { station: "kitchen", actualMin: 20, targetMin: 10, servedAt: new Date("2026-03-09T18:00:00Z") }, // over
  { station: "kitchen", actualMin: 8, targetMin: 10, servedAt: new Date("2026-03-09T18:30:00Z") },  // ok
  { station: "bar", actualMin: 5, targetMin: 3, servedAt: new Date("2026-03-09T19:00:00Z") },        // over
];

describe("aggregateBottlenecks", () => {
  it("calcula prom y % sobre target por estación", () => {
    const r = aggregateBottlenecks(rows, { timezone: "America/Bogota" });
    const k = r.byStation.find((s) => s.station === "kitchen");
    expect(k).toEqual({ station: "kitchen", items: 2, avgActualMin: 14, avgTargetMin: 10, overTargetPct: 50 });
    expect(r.worstHour.dow).toBe(1);
  });
});
