"use client";

import { useCallback, useEffect, useRef, useState } from "react";
export type MerchantPayoutStatus = "submitting" | "initialized" | "approved" | "declined" | "unknown" | "failed";
export type MerchantPayoutResult = { payoutId: string; idempotencyKey: string; amountCents: number; currency: string; status: MerchantPayoutStatus; providerRef: string | null; responseText: string | null };
export type MerchantPayoutInput = { amountCents: number; ownDestinationFingerprint?: string; destination?: { bankId: string; bankName: string; accountType: "ahorros" | "corriente"; accountNumber: string; docType: "CC" | "CE" | "NIT" | "PA"; docNumber: string; holderName: string } };
type Attempt = { restaurantId: string; idempotencyKey: string };
const unresolved = (status: MerchantPayoutStatus) => status === "submitting" || status === "unknown";
const preflightErrors = new Set(["invalid_payload", "unauthorized", "no_restaurant", "not_onboarded", "credentials_missing", "credentials_unavailable", "tenant_changed", "bank_info_invalid", "own_destination_changed", "rate_limited", "payout_in_progress"]);
const storageKey = (restaurantId: string) => "mesapay:merchant-payout:" + restaurantId;
class RequestError extends Error { constructor(public code: string) { super(code); } }
const code = (error: unknown) => error instanceof RequestError ? error.code : "connection_failed";
async function request(restaurantId: string, key: string, body?: MerchantPayoutInput): Promise<{ payout: MerchantPayoutResult | null; refreshError?: string }> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch("/api/operator/wallet/disperse" + (body ? "" : "?" + new URLSearchParams({ restaurantId, idempotencyKey: key })), {
      method: body ? "POST" : "GET", cache: "no-store", signal: controller.signal,
      ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, restaurantId, idempotencyKey: key }) } : {}),
    });
    const raw = await response.json().catch(() => null);
    if (!response.ok) throw new RequestError(typeof raw?.error === "string" ? raw.error : "payout_unavailable");
    const payout = body ? raw : raw?.payout;
    if (payout !== null && (!payout || payout.idempotencyKey !== key || typeof payout.payoutId !== "string"
      || !["submitting", "initialized", "approved", "declined", "unknown", "failed"].includes(payout.status)
      || !Number.isSafeInteger(payout.amountCents) || payout.amountCents <= 0 || typeof payout.currency !== "string" || !/^[A-Z]{3}$/.test(payout.currency))) throw new RequestError("payout_status_mismatch");
    return { payout, refreshError: typeof raw?.refreshError === "string" ? raw.refreshError : undefined };
  } finally { clearTimeout(timer); }
}
export function useMerchantPayout(restaurantId: string, onUpdate: (payout: MerchantPayoutResult) => void, initialPendingKey?: string | null, onBlocked?: () => void) {
  const [pending, setPending] = useState<Attempt | null>(null);
  const [result, setResult] = useState<MerchantPayoutResult | null>(null);
  const [ready, setReady] = useState(false);
  const [canRebuild, setCanRebuild] = useState(false);
  const [otherAttempt, setOtherAttempt] = useState(false);
  const [busy, setBusy] = useState(false);
  const [retryAvailable, setRetryAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const ambiguous = useRef(false);
  const alive = useRef(true);
  const payload = useRef<MerchantPayoutInput | null>(null);
  const keyRef = useRef<string | null>(null);
  const onUpdateRef = useRef(onUpdate);
  const onBlockedRef = useRef(onBlocked);
  useEffect(() => { onBlockedRef.current = onBlocked; }, [onBlocked]);
  useEffect(() => { onUpdateRef.current = onUpdate; }, [onUpdate]);
  const accept = useCallback((payout: MerchantPayoutResult) => {
    if (!alive.current) return;
    setResult(payout); setError(null); setCanRebuild(false); setOtherAttempt(false); ambiguous.current = unresolved(payout.status); payload.current = null; setRetryAvailable(false);
    if (!unresolved(payout.status)) {
      setPending(null); keyRef.current = null;
      try { sessionStorage.removeItem(storageKey(restaurantId)); } catch { /* Retained identity can be safely queried on reload. */ }
    }
    onUpdateRef.current(payout);
  }, [restaurantId]);
  const recover = useCallback(async (explicitKey?: string) => {
    const key = explicitKey ?? keyRef.current;
    if (!key || lock.current) return;
    keyRef.current = key; ambiguous.current = true; setPending({ restaurantId, idempotencyKey: key });
    lock.current = true; setBusy(true); setError(null);
    try {
      const value = await request(restaurantId, key);
      if (!alive.current) return;
      if (value.payout) accept(value.payout);
      else { setError("payout_not_visible"); setCanRebuild(!payload.current); }
      if (value.refreshError) setError(value.refreshError);
    } catch (error) { if (alive.current) setError(code(error)); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }, [restaurantId, accept]);
  useEffect(() => {
    alive.current = true; let active = true;
    queueMicrotask(() => {
      if (!active) return;
      let key: string | null = null;
      try {
        const raw = sessionStorage.getItem(storageKey(restaurantId)); const stored = raw ? JSON.parse(raw) : null;
        if (stored?.restaurantId === restaurantId && typeof stored.idempotencyKey === "string" && /^[0-9a-f-]{36}$/i.test(stored.idempotencyKey)) key = stored.idempotencyKey;
      } catch { /* Submission requires writable storage. */ }
      key ??= initialPendingKey ?? null;
      if (key) { keyRef.current = key; setPending({ restaurantId, idempotencyKey: key }); void recover(key); }
      setReady(true);
    });
    return () => { active = false; alive.current = false; };
  }, [restaurantId, initialPendingKey, recover]);
  async function send(input: MerchantPayoutInput) {
    if (!ready || lock.current || (pending && !payload.current && !canRebuild)) return;
    const key = keyRef.current ?? crypto.randomUUID();
    const body = payload.current ?? input;
    const attempt = { restaurantId, idempotencyKey: key };
    try { sessionStorage.setItem(storageKey(restaurantId), JSON.stringify(attempt)); }
    catch { setError("storage_unavailable"); return; }
    keyRef.current = key; payload.current = body; setCanRebuild(false); setRetryAvailable(true); setPending(attempt); setResult(null); setError(null);
    lock.current = true; setBusy(true);
    try {
      const value = await request(restaurantId, key, body);
      if (value.payout) accept(value.payout);
      else throw new RequestError("payout_not_visible");
    } catch (error) {
      if (!alive.current) return;
      const failure = code(error); setError(failure);
      // Only the first, definite preflight rejection proves this attempt was not
      // sent. An earlier timeout/reload keeps the UUID and immutable payload.
      if (!ambiguous.current && preflightErrors.has(failure)) {
        setPending(null); payload.current = null; setRetryAvailable(false);
        try { sessionStorage.removeItem(storageKey(restaurantId)); } catch { /* Same UUID remains in memory. */ }
        if (failure === "payout_in_progress") { setOtherAttempt(true); onBlockedRef.current?.(); }
      } else { ambiguous.current = true; }
    } finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  function beginNew() {
    if (busy || otherAttempt || (pending && !canRebuild) || (result && unresolved(result.status))) return false;
    if (pending && canRebuild) return true;
    setResult(null); setError(null); payload.current = null; setRetryAvailable(false); keyRef.current = null; ambiguous.current = false;
    return true;
  }
  async function retry() { if (payload.current) await send(payload.current); }
  return { pending, result, ready, busy, error, send, retry, recover, beginNew, canRebuild, canRetry: Boolean(pending && retryAvailable && !result), blocked: !ready || busy || otherAttempt || Boolean(pending && !canRebuild) };
}
export type MerchantPayoutController = ReturnType<typeof useMerchantPayout>;
