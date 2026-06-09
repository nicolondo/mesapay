import { describe, it, expect } from "vitest";
import { aggregatePayments, type PayRow } from "./paymentMix";

const rows: PayRow[] = [
  { method: "kushki_card", amountCents: 10000, tipCents: 1000 },
  { method: "kushki_card", amountCents: 20000, tipCents: 2000 },
  { method: "demo_cash", amountCents: 5000, tipCents: 0 },
];

describe("aggregatePayments", () => {
  it("agrupa por método y suma propinas; ordena por monto", () => {
    const r = aggregatePayments(rows);
    expect(r.methods[0]).toEqual({ method: "kushki_card", count: 2, amountCents: 30000, tipCents: 3000 });
    expect(r.totalAmountCents).toBe(35000);
    expect(r.totalTipCents).toBe(3000);
    expect(r.tipRatePct).toBe(9); // 3000/35000 = 8.57 → 9
  });
});
