import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeTerminalStatus, pendingTerminalIdsToObserve, watchStaffTerminal } from "./staffTerminalWatch";

const request = vi.fn<typeof fetch>();
const onResult = vi.fn();
const onRecovery = vi.fn();
const onManualAvailable = vi.fn();
let watch: ReturnType<typeof watchStaffTerminal>;

function start() {
  watch = watchStaffTerminal({
    tenantSlug: "demo", orderId: "order", method: "kushki_card_terminal",
    attemptId: "attempt", onRegistered: vi.fn(), onResult, onRecovery, onManualAvailable,
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal("fetch", request);
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  vi.stubGlobal("window", new EventTarget());
  start();
});
afterEach(() => {
  watch.stop();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("staff terminal checkout", () => {
  it("releases the busy attempt on a polled decline even without either POST response", async () => {
    request.mockResolvedValueOnce(Response.json({ paymentId: "p" }))
      .mockResolvedValueOnce(Response.json({ status: "declined", orderStatus: "served" }));
    onResult.mockImplementationOnce(() => watch.stop());
    await vi.advanceTimersByTimeAsync(4000);
    expect(onResult).toHaveBeenCalledWith({ status: "declined", orderStatus: "served" }, "p");
    expect(watch.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(onRecovery).not.toHaveBeenCalled();
  });

  it.each(["focus", "visibilitychange"])("rechecks immediately on %s, superseding a suspended read", async event => {
    request.mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce(Response.json({ status: "approved", orderStatus: "paid" }));
    watch.registered("p");
    await vi.advanceTimersByTimeAsync(0);
    (event === "focus" ? window : document).dispatchEvent(new Event(event));
    await vi.advanceTimersByTimeAsync(0);
    expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(onResult).toHaveBeenCalledWith({ status: "approved", orderStatus: "paid" }, "p");
  });

  it("offers manual recovery after four seconds and releases an unregistered POST at the deadline", async () => {
    request.mockRejectedValue(new TypeError("offline"));
    await vi.advanceTimersByTimeAsync(4000);
    expect(onManualAvailable).toHaveBeenCalledOnce();
    expect(onRecovery).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(116_000);
    expect(watch.signal.aborted).toBe(true);
    expect(onRecovery).toHaveBeenCalledExactlyOnceWith("unknown");
    expect(onResult).not.toHaveBeenCalled();
  });

  it("retains a registered pending payment through the deadline and follows its eventual approval", async () => {
    request.mockImplementation(async () => Response.json({ status: "pending" }));
    watch.registered("p");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(onRecovery).toHaveBeenCalledExactlyOnceWith("registered");
    expect(onResult).not.toHaveBeenCalled();
    request.mockResolvedValueOnce(Response.json({ status: "approved", orderStatus: "paid" }));
    await watch.check();
    expect(onResult).toHaveBeenCalledWith({ status: "approved", orderStatus: "paid" }, "p");
  });

  it.each([200, 503])("only a successful final lookup can report no payment (%s)", async status => {
    request.mockImplementation(async () => Response.json({ paymentId: null }, { status }));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(request.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true);
    expect(onRecovery).toHaveBeenCalledExactlyOnceWith(status === 200 ? "absent" : "unknown");
  });

  it("preserves both kinds of amount adjustment when the POST is lost", async () => {
    for (const [check, authorizedCents] of [["tip", 11000], ["partial", 7500]] as const) {
      const terminalAmount = { check, expectedCents: 10000, authorizedCents };
      const result = { status: "approved", orderStatus: check === "tip" ? "paid" : "served", terminalAmount };
      request.mockResolvedValueOnce(Response.json(result));
      const observer = observeTerminalStatus("demo", async () => "p", onResult);
      await observer.check();
      await observer.check();
      expect(onResult).toHaveBeenCalledWith(result, "p");
      observer.stop();
    }
    expect(onResult).toHaveBeenCalledTimes(2);
  });

  it("backs off from 4 to 10 to 30 seconds and stops automatic reads after 15 minutes", async () => {
    request.mockImplementation(async () => Response.json({ status: "pending" }));
    watch.registered("p");
    await vi.advanceTimersByTimeAsync(120_000);
    request.mockClear();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(request).toHaveBeenCalledTimes(18);
    request.mockClear();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(request).toHaveBeenCalledTimes(20);
    request.mockClear();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(request).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledOnce();
  });

  it("excludes the launch observer's payment from the refreshed order observers", () => {
    expect(pendingTerminalIdsToObserve([
      { id: "active", method: "kushki_card_terminal" },
      { id: "other", method: "external_terminal" },
      { id: "cash", method: "cash" },
    ], "active")).toEqual(["other"]);
  });

  it("keeps an unconfirmed device abort distinct from a decline", async () => {
    request.mockResolvedValueOnce(Response.json({ paymentId: "p" }))
      .mockResolvedValueOnce(Response.json({ status: "abort_requested" }));
    expect(await watch.cancel(() => true)).toBe(false);
    expect(watch.signal.aborted).toBe(true);
    expect(request.mock.calls[1][0]).toBe("/api/operator/payments/p/terminal-attempt");
    expect(onResult).not.toHaveBeenCalled();
  });
});
