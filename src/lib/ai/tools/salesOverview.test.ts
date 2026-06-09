import { describe, it, expect } from "vitest";
import { summarizeSales, type OrderRow } from "./salesOverview";

const cur: OrderRow[] = [
  { totalCents: 10000, diners: 2 },
  { totalCents: 30000, diners: 4 },
];
const prev: OrderRow[] = [{ totalCents: 20000, diners: 2 }];

describe("summarizeSales", () => {
  it("agrega y compara vs período anterior", () => {
    const r = summarizeSales(cur, prev);
    expect(r.revenueCents).toBe(40000);
    expect(r.orders).toBe(2);
    expect(r.avgTicketCents).toBe(20000);
    expect(r.diners).toBe(6);
    expect(r.revenueChangePct).toBe(100); // 40000 vs 20000
  });
  it("período anterior vacío → change null", () => {
    expect(summarizeSales(cur, []).revenueChangePct).toBeNull();
  });
});
