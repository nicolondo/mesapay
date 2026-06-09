import { describe, it, expect } from "vitest";
import { aggregateStaff, type StaffRow } from "./staffPerformance";

const rows: StaffRow[] = [
  { userName: "Ana", amountCents: 10000, tipCents: 1000, tableNumber: 1 },
  { userName: "Ana", amountCents: 20000, tipCents: 2000, tableNumber: 2 },
  { userName: "Beto", amountCents: 5000, tipCents: 0, tableNumber: 3 },
];

describe("aggregateStaff", () => {
  it("agrega por mesero, cuenta mesas distintas, ordena por ventas", () => {
    const r = aggregateStaff(rows);
    expect(r.staff[0]).toEqual({
      userName: "Ana", amountCents: 30000, tipCents: 3000, charges: 2, tables: 2, avgTicketCents: 15000,
    });
    expect(r.staff[1].userName).toBe("Beto");
  });
});
