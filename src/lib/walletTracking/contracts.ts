export type TrackingScope = { kind: "platform" } | { kind: "merchant"; restaurantId: string };
export type TrackingMode = "production" | "sandbox";
export type TrackingActor = { id?: string; email: string; role?: string };
export type TrackingSource = "order" | "subscription" | "reservation" | "voucher";
/** Snapshot the effective payment context before sending a charge. No credentials. */
export type TrackingCapture = { trackingKey: string; mode: TrackingMode; currency: string };
export type TrackingStatus = "initializing" | "active" | "stale" | "needs_review" | "unavailable" | "unsupported";
export type TrackingTotals = {
  chargesCents: number; refundsCents: number; registeredFeesCents: number;
  effectiveOutgoingCents: number; adjustmentsCents: number; incorporatedHistoryCents: number;
};
export type TrackingView = {
  trackingId: string | null; trackingKey: string | null; mode: TrackingMode | null; currency: string | null;
  startedAt: string | null; excludesEarlier: true; baselineAvailableCents: number | null; openingPendingCents: number;
  snapshotAt: string | null; lastComparedAt: string | null; status: TrackingStatus;
  estimatedPendingCents: number | null; signedDifferenceCents: number | null;
  historicalChangeToken: string | null;
  totals: TrackingTotals; ambiguousOutgoingCount: number; excludedSourceCount: number; reasons: string[];
};
export type TrackingAdjustmentInput = {
  trackingId: string; idempotencyKey: string; kind: "fee" | "external_credit" | "external_debit" | "correction";
  amountCents: number; reason: string;
  acknowledgeHistoricalChanges?: boolean; historicalChangeToken?: string;
};
export type TrackingHistoryInput = {
  trackingId: string; idempotencyKey: string; source: TrackingSource; sourceId: string;
  /** Outstanding at the tracking cutoff, not today's remainder: later balance
   * changes are already included in the cumulative comparison. Never default
   * to the full charge. */
  remainingCents: number; reason: string;
};
export type TrackingHistoryQuery = { cursor?: string; limit?: number };
export type TrackingHistoryCandidate = {
  source: TrackingSource; sourceId: string; occurredAt: string; dateBasis: "payment" | "record";
  amountCents: number; refundedCents: number; currency: string | null;
  maxOpeningPendingCents: number;
  eligible: boolean; reason: string | null; incorporatedCents: number | null;
};
export type TrackingHistoryPage = { trackingId: string | null; candidates: TrackingHistoryCandidate[]; nextCursor: string | null };
export type TrackingBatchResult = { scanned: number; synced: number; failed: number; busy: number; truncated: boolean };
