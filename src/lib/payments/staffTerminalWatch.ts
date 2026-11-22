type TerminalResult = {
  id: string;
  status: "pending" | "approved" | "declined" | "refunded";
  orderStatus: string;
  nextPaymentId?: string;
  declineReason?: string;
};

type Options = {
  tenantSlug: string;
  orderId: string;
  method: "kushki_card_terminal" | "external_terminal";
  attemptId: string;
  onManualAvailable: () => void;
  onResult: (result: TerminalResult, id: string) => void;
  onTimeout: (id: string | null) => void;
};

export function observeTerminalStatus(
  tenantSlug: string,
  lookup: (signal: AbortSignal) => Promise<string | null>,
  onResult: (result: TerminalResult, id: string) => void,
  onResume?: () => void,
) {
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
      if (["approved", "declined", "refunded"].includes(result.status)) onResult(result, paymentId);
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

  const poll = setInterval(() => void read(), 4000);
  document.addEventListener("visibilitychange", resume);
  window.addEventListener("focus", resume);
  return {
    check: () => read(true),
    stop() {
      stopped = true;
      pendingRead?.abort();
      clearInterval(poll);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
    },
  };
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

  async function lookup(signal: AbortSignal) {
    if (id) return id;
    const query = new URLSearchParams({ attempt: attemptId, method });
    const response = await fetch(`/api/tenant/${tenantSlug}/orders/${orderId}/terminal-status?${query}`, { cache: "no-store", signal });
    if (!response.ok) return null;
    const data = await response.json();
    if (!signal.aborted && typeof data.paymentId === "string") id = data.paymentId;
    return id;
  }

  function expire() {
    if (post.signal.aborted) return;
    post.abort();
    options.onTimeout(id);
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
  });
  const timeout = setTimeout(expire, 120_000);
  const manual = setTimeout(() => { if (!post.signal.aborted) options.onManualAvailable(); }, 4000);
  return {
    signal: post.signal,
    registered(paymentId: string) {
      id = paymentId;
      void observer.check();
    },
    check: observer.check,
    async consult() {
      const limit = new AbortController();
      const timer = setTimeout(() => limit.abort(), 6000);
      try {
        const paymentId = await lookup(limit.signal);
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
        const paymentId = await lookup(limit.signal);
        if (!paymentId || stopped) return false;
        let result = method === "kushki_card_terminal"
          ? await send(paymentId, "terminal-attempt", limit.signal, { action: "cancel" })
          : await send(paymentId, "cancel-request", limit.signal);
        if (result.error === "terminal_not_sent") result = await send(paymentId, "cancel-request", limit.signal);
        if (result.error === "confirmation_required" && !stopped && confirmNotCharged()) {
          result = await send(paymentId, "terminal-attempt", limit.signal, { action: "cancel", confirmed: true });
        }
        return result.status === "declined";
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
