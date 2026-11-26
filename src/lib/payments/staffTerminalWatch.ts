import type { TerminalAmountView } from "./terminalAmount";

export type TerminalResult = {
  id: string;
  status: "pending" | "approved" | "declined" | "refunded";
  orderStatus: string;
  terminalAmount?: TerminalAmountView | null;
  nextPaymentId?: string;
  declineReason?: string;
  terminalAttempt?: { gatewayTimedOut?: boolean } | null;
};

type Options = {
  tenantSlug: string;
  orderId: string;
  method: "kushki_card_terminal" | "external_terminal";
  attemptId: string;
  onGatewayTimeout?: () => void;
  onManualAvailable: () => void;
  onResult: (result: TerminalResult, id: string) => void;
  onRegistered: (id: string) => void;
  onRecovery: (outcome: "absent" | "registered" | "unknown") => void;
};

export function pendingTerminalIdsToObserve(
  payments: ReadonlyArray<{ id: string; method: string }>, owned: string | null,
) {
  return payments.filter(p => p.id !== owned && (p.method === "kushki_card_terminal" || p.method === "external_terminal"))
    .map(p => p.id);
}

export function observeTerminalStatus(
  tenantSlug: string,
  lookup: (signal: AbortSignal) => Promise<string | null>,
  onResult: (result: TerminalResult, id: string) => void,
  onResume?: () => void,
  onGatewayTimeout?: () => void,
) {
  const started = Date.now();
  let poll: ReturnType<typeof setTimeout>;
  let stopped = false;
  let pendingRead: AbortController | null = null;
  async function read(force = false) {
    if (stopped || (pendingRead && !force)) return;
    pendingRead?.abort();
    const request = new AbortController();
    pendingRead = request;
    const readTimeout = setTimeout(() => request.abort(), 8000);
    try {
      const paymentId = await lookup(request.signal);
      if (!paymentId || request.signal.aborted) return;
      const response = await fetch(`/api/tenant/${tenantSlug}/payment/${paymentId}`, {
        cache: "no-store", signal: request.signal,
      });
      if (!response.ok) return;
      const result: TerminalResult = await response.json();
      if (request.signal.aborted || stopped) return;
      if (result.status === "pending" && result.terminalAttempt?.gatewayTimedOut) onGatewayTimeout?.();
      if (["approved", "declined", "refunded"].includes(result.status)) {
        stop();
        onResult(result, paymentId);
        return result;
      }
    } catch { /* Retry on the next tick or foreground event. */ }
    finally {
      clearTimeout(readTimeout);
      if (pendingRead === request) pendingRead = null;
    }
  }

  function resume() {
    if (document.visibilityState === "hidden") return;
    void read(true);
    onResume?.();
  }

  function schedule() {
    const elapsed = Date.now() - started;
    // After 15 minutes only explicit checks and foreground events read.
    if (stopped || elapsed >= 15 * 60_000) return;
    const delay = elapsed < 120_000 ? 4000 : elapsed < 300_000 ? 10_000 : 30_000;
    poll = setTimeout(() => {
      if (document.visibilityState !== "hidden") void read();
      schedule();
    }, delay);
  }

  function stop() {
    stopped = true;
    pendingRead?.abort();
    clearTimeout(poll);
    document.removeEventListener("visibilitychange", resume);
    window.removeEventListener("focus", resume);
  }

  schedule();
  document.addEventListener("visibilitychange", resume);
  window.addEventListener("focus", resume);
  return { check: () => read(true), stop };
}

// Keep reading after an ambiguous cancellation. Aborting the browser POST
// prevents a late response from navigating or starting a new push. Only the
// existing server-side cancellation routes can decide the payment outcome.
export function watchStaffTerminal(options: Options) {
  const { tenantSlug, orderId, method, attemptId } = options;
  const post = new AbortController();
  const deadline = Date.now() + 120_000;
  let id: string | null = null;
  let stopped = false;

  function registered(paymentId: string) {
    if (stopped || id === paymentId) return;
    id = paymentId;
    options.onRegistered(id);
  }

  async function lookup(signal: AbortSignal, closeIfAbsent = false) {
    if (id) return id;
    const query = new URLSearchParams({ attempt: attemptId, method });
    const response = await fetch(`/api/tenant/${tenantSlug}/orders/${orderId}/terminal-status?${query}`, {
      method: closeIfAbsent ? "POST" : "GET", cache: "no-store", signal,
    });
    if (!response.ok) throw new Error("terminal_lookup_failed");
    const data = await response.json();
    if (signal.aborted || stopped) throw new Error("terminal_lookup_stopped");
    if (typeof data.paymentId === "string") registered(data.paymentId);
    else if (data.paymentId !== null) throw new Error("invalid_terminal_lookup");
    return id;
  }

  async function expire() {
    if (post.signal.aborted) return;
    post.abort();
    const limit = new AbortController();
    const timer = setTimeout(() => limit.abort(), 6000);
    try {
      const paymentId = await lookup(limit.signal, true);
      if (!stopped) options.onRecovery(paymentId ? "registered" : "absent");
    } catch {
      if (!stopped) options.onRecovery("unknown");
    } finally { clearTimeout(timer); }
  }

  async function send(paymentId: string, action: string, signal: AbortSignal, body?: object) {
    const response = await fetch(`/api/operator/payments/${paymentId}/${action}`, {
      method: "POST", signal, headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    return response.json();
  }

  const observer = observeTerminalStatus(tenantSlug, lookup, options.onResult, () => {
    if (Date.now() >= deadline) expire();
  }, options.onGatewayTimeout);
  const timeout = setTimeout(expire, 120_000);
  const manual = setTimeout(() => { if (!post.signal.aborted) options.onManualAvailable(); }, 4000);
  return {
    signal: post.signal,
    registered(paymentId: string) {
      registered(paymentId);
      void observer.check();
    },
    check: observer.check,
    async consult() {
      const limit = new AbortController();
      const timer = setTimeout(() => limit.abort(), 6000);
      try {
        const paymentId = await lookup(limit.signal, post.signal.aborted);
        if (!paymentId && post.signal.aborted && !stopped) options.onRecovery("absent");
        if (paymentId && !stopped && method === "kushki_card_terminal") {
          await send(paymentId, "terminal-attempt", limit.signal, { action: "check" });
        }
      } catch { /* The local payment can still have settled. */ }
      finally { clearTimeout(timer); }
      await observer.check();
    },
    async cancel(confirmNotCharged: () => boolean) {
      post.abort();
      const limit = new AbortController();
      const timer = setTimeout(() => limit.abort(), 6000);
      try {
        const paymentId = await lookup(limit.signal, true);
        if (!paymentId && !stopped) options.onRecovery("absent");
        if (!paymentId || stopped) return false;
        let result = method === "kushki_card_terminal"
          ? await send(paymentId, "terminal-attempt", limit.signal, { action: "cancel" })
          : await send(paymentId, "cancel-request", limit.signal);
        if (result.error === "terminal_not_sent") result = await send(paymentId, "cancel-request", limit.signal);
        if (result.error === "confirmation_required" && !stopped && confirmNotCharged()) {
          result = await send(paymentId, "terminal-attempt", limit.signal, { action: "cancel", confirmed: true });
        }
        if (result.status !== "declined") return false;
        if (!stopped) options.onResult({
          id: paymentId, status: "declined", orderStatus: result.orderStatus, declineReason: "terminal_canceled",
        }, paymentId);
        return true;
      } catch { return false; }
      finally { clearTimeout(timer); }
    },
    stop() {
      stopped = true;
      post.abort();
      observer.stop();
      clearTimeout(timeout);
      clearTimeout(manual);
    },
  };
}
