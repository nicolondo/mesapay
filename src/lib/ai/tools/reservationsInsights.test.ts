import { describe, it, expect } from "vitest";
import { aggregateReservations, type ResRow } from "./reservationsInsights";

const rows: ResRow[] = [
  { status: "completed", partySize: 4, depositStatus: "applied", depositCents: 5000 },
  { status: "no_show", partySize: 2, depositStatus: "forfeited", depositCents: 3000 },
  { status: "cancelled", partySize: 2, depositStatus: "refunded", depositCents: 0 },
  { status: "confirmed", partySize: 3, depositStatus: "paid", depositCents: 4000 },
];

describe("aggregateReservations", () => {
  it("cuenta por estado, no-show rate y depósitos", () => {
    const r = aggregateReservations(rows);
    expect(r.total).toBe(4);
    expect(r.byStatus).toContainEqual({ status: "no_show", count: 1 });
    expect(r.noShowPct).toBe(25);
    expect(r.depositsForfeitedCents).toBe(3000);
    expect(r.totalGuests).toBe(11);
  });
});
