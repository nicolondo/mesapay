import { describe, expect, it } from "vitest";
import { calculateTracking, safeTrackingCents } from "./calculation";
const bi = BigInt;
const base = { baselineAvailableCents: bi(50000), openingPendingCents: bi(0), availableCents: bi(50000), chargesCents: bi(0), refundsCents: bi(0), registeredFeesCents: bi(0), effectiveOutgoingCents: bi(0), adjustmentsCents: bi(0), incorporatedHistoryCents: bi(0) };
describe("signed wallet estimate", () => {
  it("does not consume the initial available balance", () => {
    expect(calculateTracking({ ...base, chargesCents: bi(10000) }).signedDifferenceCents).toBe(bi(10000));
  });
  it("reduces the estimate by a balance increase and compensates a known payout", () => {
    expect(calculateTracking({ ...base, chargesCents: bi(10000), availableCents: bi(60000) }).signedDifferenceCents).toBe(bi(0));
    expect(calculateTracking({ ...base, chargesCents: bi(10000), availableCents: bi(52000), effectiveOutgoingCents: bi(8000) }).signedDifferenceCents).toBe(bi(0));
  });
  it("handles refund before or after balance credit without double subtraction", () => {
    expect(calculateTracking({ ...base, chargesCents: bi(10000), refundsCents: bi(2000) }).signedDifferenceCents).toBe(bi(8000));
    expect(calculateTracking({ ...base, chargesCents: bi(10000), refundsCents: bi(2000), availableCents: bi(58000) }).signedDifferenceCents).toBe(bi(0));
  });
  it("preserves a negative timing difference instead of losing its carry", () => {
    const delayed = calculateTracking({ ...base, chargesCents: bi(10000), refundsCents: bi(2000), availableCents: bi(60000) });
    expect(delayed).toMatchObject({ signedDifferenceCents: bi(-2000), estimatedPendingCents: null, status: "needs_review" });
    expect(calculateTracking({ ...base, chargesCents: bi(10000), refundsCents: bi(2000), availableCents: bi(58000) }).signedDifferenceCents).toBe(bi(0));
  });
  it("accounts for explicitly recorded fees and external credits/debits", () => {
    expect(calculateTracking({ ...base, chargesCents: bi(10000), registeredFeesCents: bi(300), availableCents: bi(59700) }).signedDifferenceCents).toBe(bi(0));
    expect(calculateTracking({ ...base, adjustmentsCents: bi(3000), availableCents: bi(53000) }).signedDifferenceCents).toBe(bi(0));
    expect(calculateTracking({ ...base, adjustmentsCents: bi(-3000), availableCents: bi(47000) }).signedDifferenceCents).toBe(bi(0));
  });
  it("includes only the explicitly incorporated historical remainder", () => {
    expect(calculateTracking({ ...base, incorporatedHistoryCents: bi(7000), availableCents: bi(51000) }).signedDifferenceCents).toBe(bi(6000));
  });
  it("blocks uncertain outgoing operations or incomplete source coverage", () => {
    expect(calculateTracking({ ...base, blocked: true })).toMatchObject({ status: "needs_review", estimatedPendingCents: null, signedDifferenceCents: null });
  });
  it("does exact large integer arithmetic and rejects unsafe DTO numbers", () => {
    const large = bi("1390000000000");
    expect(calculateTracking({ ...base, chargesCents: large }).signedDifferenceCents).toBe(large);
    expect(safeTrackingCents(large)).toBe(1390000000000);
    expect(() => safeTrackingCents(bi("9007199254740992"))).toThrow("unsafe_money");
  });
});
