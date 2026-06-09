import { describe, it, expect } from "vitest";
import { aggregateTurnover, type TurnRow } from "./tablesTurnover";

const rows: TurnRow[] = [
  { tableNumber: 1, occupancyMin: 60 },
  { tableNumber: 1, occupancyMin: 40 },
  { tableNumber: 2, occupancyMin: 90 },
];

describe("aggregateTurnover", () => {
  it("calcula vueltas y ocupación promedio por mesa y global", () => {
    const r = aggregateTurnover(rows);
    expect(r.byTable).toContainEqual({ tableNumber: 1, turns: 2, avgOccupancyMin: 50 });
    expect(r.avgOccupancyMin).toBe(63); // (60+40+90)/3 = 63.33 → 63
    expect(r.totalTurns).toBe(3);
  });
});
