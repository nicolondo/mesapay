import { describe, it, expect } from "vitest";
import { estimateStaffing, type LoadRow } from "./staffingEstimate";

const rows: LoadRow[] = [
  { at: new Date("2026-03-09T18:00:00Z") }, // lun 13h Bogotá
  { at: new Date("2026-03-09T18:10:00Z") },
  { at: new Date("2026-03-09T18:20:00Z") },
];

describe("estimateStaffing", () => {
  it("agrupa por dow×hora y estima meseros con techo", () => {
    const r = estimateStaffing(rows, { timezone: "America/Bogota", ordersPerWaiterHour: 2 });
    const cell = r.byHour.find((c) => c.dow === 1 && c.hour === 13);
    expect(cell).toEqual({ dow: 1, hour: 13, orders: 3, suggestedWaiters: 2 }); // ceil(3/2)=2
    expect(r.peak.suggestedWaiters).toBe(2);
  });
});
