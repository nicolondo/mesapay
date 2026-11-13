"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { TrackingAdjustmentInput, TrackingHistoryInput, TrackingView } from "@/lib/walletTracking/contracts";
import { readTrackingView, trackingRecoveryOutcome, trackingErrorCode, trackingRequest, TrackingRequestError, type WalletSurface } from "./client";

export type PendingTrackingOperation = { key: string; trackingId: string; path: "/adjustments" | "/history" };
export type TrackingMutation = TrackingAdjustmentInput | TrackingHistoryInput;
const storageKey = (surface: WalletSurface, scopeId: string) => `mesapay:wallet-tracking:${surface}:${scopeId}`;
function restore(surface: WalletSurface, scopeId: string): PendingTrackingOperation | null {
  try {
    const raw = sessionStorage.getItem(storageKey(surface, scopeId));
    const v = raw ? JSON.parse(raw) : null;
    if (v && typeof v.key === "string" && /^[0-9a-f-]{36}$/i.test(v.key) && typeof v.trackingId === "string" && ["/adjustments", "/history"].includes(v.path)) return { key: v.key, trackingId: v.trackingId, path: v.path };
  } catch { /* A new mutation still requires working storage before sending. */ }
  return null;
}
export function useWalletTracking(surface: WalletSurface, scopeId: string | null) {
  const [state, setState] = useState<{ scopeId: string | null; view: TrackingView | null; loading: boolean; error: string | null }>({ scopeId, view: null, loading: true, error: null });
  const [pendingState, setPending] = useState<{ scopeId: string; operation: PendingTrackingOperation } | null>(null);
  const sequence = useRef(0);
  const inFlight = useRef(false);
  const pending = pendingState?.scopeId === scopeId ? pendingState.operation : null;
  const clearPending = useCallback(() => {
    if (!scopeId) return;
    try { sessionStorage.removeItem(storageKey(surface, scopeId)); } catch { /* Server idempotency remains authoritative. */ }
    setPending(null);
  }, [scopeId, surface]);
  const sync = useCallback(async (signal?: AbortSignal) => {
    if (!scopeId || inFlight.current) return;
    const request = ++sequence.current;
    inFlight.current = true;
    setState(old => ({ scopeId, view: old.scopeId === scopeId ? old.view : null, loading: true, error: null }));
    try {
      const raw = await trackingRequest(surface, scopeId, "", { body: { action: "sync" }, signal });
      const view = readTrackingView(raw, surface, scopeId);
      if (sequence.current === request) setState({ scopeId, view, loading: false, error: null });
    } catch (error) {
      if (signal?.aborted || sequence.current !== request) return;
      // The POST may have committed its snapshot before its response was lost.
      try {
        const raw = await trackingRequest(surface, scopeId, "", { signal });
        const view = readTrackingView(raw, surface, scopeId);
        if (sequence.current === request) setState({ scopeId, view, loading: false, error: trackingErrorCode(error) });
      } catch {
        if (sequence.current === request) setState(old => ({ scopeId, view: old.scopeId === scopeId ? old.view : null, loading: false, error: trackingErrorCode(error) }));
      }
    } finally { if (sequence.current === request) inFlight.current = false; }
  }, [surface, scopeId]);
  const recover = useCallback(async (operation: PendingTrackingOperation) => {
    if (!scopeId || inFlight.current) return;
    const request = ++sequence.current;
    inFlight.current = true;
    setState(old => ({ ...old, loading: true, error: null }));
    try {
      const raw = await trackingRequest(surface, scopeId, "", { query: { operationId: operation.key } });
      const view = readTrackingView(raw, surface, scopeId);
      if (sequence.current !== request) return;
      const recovery = trackingRecoveryOutcome(raw.operationFound, operation.trackingId, view.trackingId);
      if (recovery !== "pending") clearPending();
      setState({ scopeId, view, loading: false, error: recovery === "applied" ? null : recovery === "superseded" ? "pending_context_changed" : "operation_not_found" });
    } catch (error) {
      if (sequence.current === request) setState(old => ({ ...old, loading: false, error: trackingErrorCode(error) }));
    } finally { if (sequence.current === request) inFlight.current = false; }
  }, [surface, scopeId, clearPending]);
  useEffect(() => {
    if (!scopeId) return;
    let alive = true;
    const requestSequence = sequence;
    const controller = new AbortController();
    queueMicrotask(async () => {
      if (!alive) return;
      const operation = restore(surface, scopeId);
      setPending(operation ? { scopeId, operation } : null);
      await sync(controller.signal);
      if (alive && operation) await recover(operation);
    });
    return () => { alive = false; controller.abort(); requestSequence.current++; inFlight.current = false; };
  }, [surface, scopeId, sync, recover]);
  const mutate = useCallback(async (path: PendingTrackingOperation["path"], body: TrackingMutation) => {
    if (!scopeId || inFlight.current) throw new TrackingRequestError("tracking_busy");
    if (pending && (pending.key !== body.idempotencyKey || pending.path !== path || pending.trackingId !== body.trackingId)) throw new TrackingRequestError("pending_operation");
    const operation = { key: body.idempotencyKey, trackingId: body.trackingId, path };
    try { sessionStorage.setItem(storageKey(surface, scopeId), JSON.stringify(operation)); }
    catch { throw new TrackingRequestError("storage_unavailable"); }
    setPending({ scopeId, operation });
    const request = ++sequence.current;
    inFlight.current = true;
    setState(old => ({ ...old, loading: true, error: null }));
    try {
      const raw = await trackingRequest(surface, scopeId, path, { body });
      const view = readTrackingView(raw, surface, scopeId);
      if (sequence.current !== request) throw new TrackingRequestError("account_changed");
      clearPending();
      setState({ scopeId, view, loading: false, error: null });
      return view;
    } catch (error) {
      if (sequence.current === request) setState(old => ({ ...old, loading: false, error: trackingErrorCode(error) }));
      throw error;
    } finally { if (sequence.current === request) inFlight.current = false; }
  }, [scopeId, surface, pending, clearPending]);
  return {
    surface, scopeId, view: state.scopeId === scopeId ? state.view : null,
    loading: state.scopeId === scopeId ? state.loading : true,
    error: state.scopeId === scopeId ? state.error : null,
    pending, sync, mutate, recover: () => pending ? recover(pending) : Promise.resolve(),
  };
}
export type WalletTrackingController = ReturnType<typeof useWalletTracking>;
