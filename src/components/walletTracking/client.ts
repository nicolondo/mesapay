import type { TrackingHistoryPage, TrackingView } from "@/lib/walletTracking/contracts";

export type WalletSurface = "admin" | "operator";
export class TrackingRequestError extends Error {
  constructor(public code: string) { super(code); }
}
export const trackingContext = (surface: WalletSurface, scopeId: string): Record<string, string> => surface === "admin" ? { accountId: scopeId } : { restaurantId: scopeId };
const safe = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const nonnegative = (value: unknown): value is number => safe(value) && value >= 0;
const nullableDate = (value: unknown) => value === null || (typeof value === "string" && Number.isFinite(Date.parse(value)));
const currency = (value: unknown) => value === null || (typeof value === "string" && /^[A-Z]{3}$/.test(value));

/** MoneyInput emits ungrouped major units. Keep cents exact, including signed corrections. */
export function parseTrackingAmount(raw: string, allowNegative = false): number | null {
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(raw) || (!allowNegative && raw.startsWith("-"))) return null;
  const negative = raw.startsWith("-");
  const [whole, fraction = ""] = (negative ? raw.slice(1) : raw).split(".");
  const cents = (BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, "0"))) * BigInt(negative ? -1 : 1);
  return cents > BigInt(Number.MAX_SAFE_INTEGER) || cents < BigInt(Number.MIN_SAFE_INTEGER) ? null : Number(cents);
}
export function assertTrackingScope(raw: unknown, surface: WalletSurface, scopeId: string): asserts raw is Record<string, unknown> {
  if (!raw || typeof raw !== "object" || (raw as Record<string, unknown>)[surface === "admin" ? "accountId" : "restaurantId"] !== scopeId) throw new TrackingRequestError("account_changed");
}
export function readTrackingView(raw: unknown, surface: WalletSurface, scopeId: string): TrackingView {
  assertTrackingScope(raw, surface, scopeId);
  const v = raw as unknown as TrackingView;
  const identifiers = [v.trackingId, v.trackingKey];
  if (!identifiers.every(id => id === null || typeof id === "string")
    || ![null, "production", "sandbox"].includes(v.mode) || !currency(v.currency)
    || ![v.startedAt, v.snapshotAt, v.lastComparedAt].every(nullableDate)
    || v.excludesEarlier !== true || !nonnegative(v.openingPendingCents)
    || !(v.baselineAvailableCents === null || nonnegative(v.baselineAvailableCents))
    || !["initializing", "active", "stale", "needs_review", "unavailable", "unsupported"].includes(v.status)
    || !(v.estimatedPendingCents === null || nonnegative(v.estimatedPendingCents))
    || !(v.signedDifferenceCents === null || safe(v.signedDifferenceCents))
    || !nonnegative(v.ambiguousOutgoingCount) || !nonnegative(v.excludedSourceCount)
    || !Array.isArray(v.reasons) || !v.reasons.every(reason => typeof reason === "string")
    || !(v.historicalChangeToken == null || (typeof v.historicalChangeToken === "string" && /^[a-f0-9]{64}$/.test(v.historicalChangeToken)))
    || !v.totals || ![v.totals.chargesCents, v.totals.refundsCents, v.totals.registeredFeesCents,
      v.totals.effectiveOutgoingCents, v.totals.incorporatedHistoryCents].every(nonnegative)
    || !safe(v.totals.adjustmentsCents)) throw new TrackingRequestError("invalid_response");
  return { ...v, historicalChangeToken: v.historicalChangeToken ?? null };
}
/** A stale same-account snapshot remains useful; blocked or rotated context does not. */
export function trackingEstimateForDisplay(view: TrackingView | null): number | null {
  if (!view || !["active", "stale"].includes(view.status) || !view.currency || view.reasons.includes("account_changed")
    || !nonnegative(view.estimatedPendingCents) || (view.signedDifferenceCents !== null && view.signedDifferenceCents < 0)) return null;
  return view.estimatedPendingCents;
}
export function trackingRecoveryOutcome(found: unknown, pendingTrackingId: string, currentTrackingId: string | null): "applied" | "superseded" | "pending" {
  if (found === true) return "applied";
  if (found === false && currentTrackingId && currentTrackingId !== pendingTrackingId) return "superseded";
  return "pending";
}
export function readTrackingHistory(raw: unknown, surface: WalletSurface, scopeId: string): TrackingHistoryPage {
  assertTrackingScope(raw, surface, scopeId);
  const v = raw as unknown as TrackingHistoryPage;
  if (!(v.trackingId === null || typeof v.trackingId === "string") || !(v.nextCursor === null || typeof v.nextCursor === "string")
    || !Array.isArray(v.candidates) || !v.candidates.every(c => c && ["order", "subscription", "reservation", "voucher"].includes(c.source)
      && typeof c.sourceId === "string" && typeof c.occurredAt === "string" && nullableDate(c.occurredAt)
      && ["payment", "record"].includes(c.dateBasis) && nonnegative(c.amountCents) && nonnegative(c.refundedCents)
      && (c.maxOpeningPendingCents == null || nonnegative(c.maxOpeningPendingCents))
      && currency(c.currency) && typeof c.eligible === "boolean" && (c.reason === null || typeof c.reason === "string")
      && (c.incorporatedCents === null || nonnegative(c.incorporatedCents)))) throw new TrackingRequestError("invalid_response");
  return v;
}
export async function trackingRequest(surface: WalletSurface, scopeId: string, path = "", options?: { body?: unknown; query?: Record<string, string>; signal?: AbortSignal }): Promise<Record<string, unknown>> {
  const query = new URLSearchParams({ ...trackingContext(surface, scopeId), ...options?.query });
  const controller = new AbortController();
  const abort = () => controller.abort();
  options?.signal?.addEventListener("abort", abort, { once: true });
  if (options?.signal?.aborted) controller.abort();
  const timer = setTimeout(abort, 45000);
  try {
    const response = await fetch(`/api/${surface}/wallet/tracking${path}${options?.body === undefined ? "?" + query : ""}`, {
      method: options?.body === undefined ? "GET" : "POST", cache: "no-store", signal: controller.signal,
      ...(options?.body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify({ ...options.body as object, ...trackingContext(surface, scopeId) }) }),
    });
    const value = await response.json().catch(() => null);
    if (!response.ok) throw new TrackingRequestError(typeof value?.error === "string" ? value.error : "tracking_unavailable");
    assertTrackingScope(value, surface, scopeId);
    return value;
  } catch (error) {
    if (error instanceof TrackingRequestError) throw error;
    throw new TrackingRequestError("connection_failed");
  } finally { clearTimeout(timer); options?.signal?.removeEventListener("abort", abort); }
}
export const trackingErrorCode = (error: unknown) => error instanceof TrackingRequestError ? error.code : "tracking_unavailable";
