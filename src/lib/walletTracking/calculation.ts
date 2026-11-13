import { TrackingError } from "./errors";

export type TrackingAmounts = {
  chargesCents: bigint; refundsCents: bigint; registeredFeesCents: bigint;
  effectiveOutgoingCents: bigint; adjustmentsCents: bigint; incorporatedHistoryCents: bigint;
};
export function calculateTracking(input: TrackingAmounts & {
  baselineAvailableCents: bigint; openingPendingCents: bigint; availableCents: bigint; blocked?: boolean;
}) {
  if (input.blocked) return { signedDifferenceCents: null, estimatedPendingCents: null, status: "needs_review" as const };
  const difference = input.openingPendingCents + input.chargesCents - input.refundsCents - input.registeredFeesCents
    + input.adjustmentsCents + input.incorporatedHistoryCents
    - (input.availableCents - input.baselineAvailableCents) - input.effectiveOutgoingCents;
  return { signedDifferenceCents: difference, estimatedPendingCents: difference < BigInt(0) ? null : difference,
    status: difference < BigInt(0) ? "needs_review" as const : "active" as const };
}
export function safeTrackingCents(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new TrackingError("unsafe_money", 503);
  return result;
}
