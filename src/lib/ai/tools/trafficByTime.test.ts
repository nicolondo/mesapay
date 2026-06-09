import { describe, it, expect } from "vitest";
import { aggregateTraffic, type TrafficRow } from "./trafficByTime";

const rows: TrafficRow[] = [
  { at: new Date("2026-03-09T18:00:00Z"), revenueCents: 10000 }, // lun 13h Bogotá
  { at: new Date("2026-03-09T18:30:00Z"), revenueCents: 5000 },  // lun 13h
  { at: new Date("2026-03-10T01:00:00Z"), revenueCents: 8000 },  // lun 20h
];

describe("aggregateTraffic", () => {
  it("bucketea por dow×hora local y marca el pico", () => {
    const r = aggregateTraffic(rows, { timezone: "America/Bogota" });
    const peak = r.cells.find((c) => c.dow === 1 && c.hour === 13);
    expect(peak).toEqual({ dow: 1, hour: 13, orders: 2, revenueCents: 15000 });
    expect(r.busiest.dow).toBe(1);
    expect(r.busiest.hour).toBe(13);
  });
});
