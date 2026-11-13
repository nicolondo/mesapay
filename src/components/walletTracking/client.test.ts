import { describe, expect, it } from "vitest";
import { parseTrackingAmount, readTrackingView, trackingContext, trackingEstimateForDisplay, trackingRecoveryOutcome } from "./client";

const view = () => ({
  accountId: "wallet-a", trackingId: "tracking-a", trackingKey: "key-a", mode: "production", currency: "COP",
  startedAt: "2026-11-10T15:00:00.000Z", excludesEarlier: true, baselineAvailableCents: 1_000_000, openingPendingCents: 0,
  snapshotAt: "2026-11-10T15:05:00.000Z", lastComparedAt: "2026-11-10T15:05:00.000Z", status: "active",
  estimatedPendingCents: 250_030, signedDifferenceCents: 250_030,
  totals: { chargesCents: 500_000, refundsCents: 0, registeredFeesCents: 100_000, effectiveOutgoingCents: 0, adjustmentsCents: -149_970, incorporatedHistoryCents: 0 },
  ambiguousOutgoingCount: 0, excludedSourceCount: 0, reasons: ["earlier_excluded"],
});

describe("wallet tracking UI boundary", () => {
  it("keeps centavos without floating-point rounding", () => {
    expect(parseTrackingAmount("0.29")).toBe(29);
    expect(parseTrackingAmount("246498.30")).toBe(24_649_830);
    expect(parseTrackingAmount("0")).toBe(0);
  });
  it.each(["", "-", "1e3", "1.234", "1,50", "Infinity", "90071992547409.92"])("rejects an invalid monetary draft %s", value => {
    expect(parseTrackingAmount(value, true)).toBeNull();
  });
  it("permits signed corrections only when requested", () => {
    expect(parseTrackingAmount("-12.50")).toBeNull();
    expect(parseTrackingAmount("-12.50", true)).toBe(-1250);
  });
  it("separates known zero from a missing estimate and keeps a negative discrepancy", () => {
    expect(readTrackingView({ ...view(), estimatedPendingCents: 0 }, "admin", "wallet-a").estimatedPendingCents).toBe(0);
    const discrepancy = readTrackingView({ ...view(), status: "needs_review", estimatedPendingCents: null, signedDifferenceCents: -530 }, "admin", "wallet-a");
    expect(discrepancy.estimatedPendingCents).toBeNull();
    expect(discrepancy.signedDifferenceCents).toBe(-530);
  });
  it("rejects a response belonging to another wallet or merchant", () => {
    expect(() => readTrackingView(view(), "admin", "wallet-b")).toThrow("account_changed");
    expect(() => readTrackingView({ ...view(), restaurantId: "merchant-a" }, "operator", "merchant-b")).toThrow("account_changed");
    expect(trackingContext("operator", "merchant-a")).toEqual({ restaurantId: "merchant-a" });
  });
  it.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid pending money %s", value => {
    expect(() => readTrackingView({ ...view(), estimatedPendingCents: value }, "admin", "wallet-a")).toThrow("invalid_response");
  });
  it.each(["needs_review", "initializing", "unavailable", "unsupported"])("does not present inconsistent pending money when status is %s", status => {
    expect(trackingEstimateForDisplay(readTrackingView({ ...view(), status }, "admin", "wallet-a"))).toBeNull();
  });
  it("keeps a dated temporary stale amount but hides a value from changed account context", () => {
    expect(trackingEstimateForDisplay(readTrackingView({ ...view(), status: "stale" }, "admin", "wallet-a"))).toBe(250030);
    expect(trackingEstimateForDisplay(readTrackingView({ ...view(), status: "stale", reasons: ["account_changed"] }, "admin", "wallet-a"))).toBeNull();
  });
  it("releases only a found operation or an explicitly absent operation from a superseded tracker", () => {
    expect(trackingRecoveryOutcome(true, "old", "new")).toBe("applied");
    expect(trackingRecoveryOutcome(false, "old", "new")).toBe("superseded");
    expect(trackingRecoveryOutcome(false, "same", "same")).toBe("pending");
    expect(trackingRecoveryOutcome(undefined, "old", "new")).toBe("pending");
    expect(trackingRecoveryOutcome(false, "old", null)).toBe("pending");
  });
  it("never substitutes a currency or tracking date", () => {
    expect(readTrackingView({ ...view(), status: "unavailable", currency: null, startedAt: null, estimatedPendingCents: null }, "admin", "wallet-a").currency).toBeNull();
    expect(() => readTrackingView({ ...view(), currency: "money", startedAt: "bad-date" }, "admin", "wallet-a")).toThrow("invalid_response");
  });
});
