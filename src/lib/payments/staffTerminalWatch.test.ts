import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchStaffTerminal } from "./staffTerminalWatch";

const request = vi.fn<typeof fetch>();
const onResult = vi.fn();
const onTimeout = vi.fn();
const onManualAvailable = vi.fn();
let watch: ReturnType<typeof watchStaffTerminal>;

function start() {
  watch = watchStaffTerminal({
    tenantSlug: "demo", orderId: "order", method: "kushki_card_terminal",
    attemptId: "attempt", onResult, onTimeout, onManualAvailable,
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
    expect(onTimeout).not.toHaveBeenCalled();
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
    expect(onTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(116_000);
    expect(watch.signal.aborted).toBe(true);
    expect(onTimeout).toHaveBeenCalledExactlyOnceWith(null);
    expect(onResult).not.toHaveBeenCalled();
  });

  it("retains a registered pending payment through the deadline and follows its eventual approval", async () => {
    request.mockImplementation(async () => Response.json({ status: "pending" }));
    watch.registered("p");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(onTimeout).toHaveBeenCalledExactlyOnceWith("p");
    expect(onResult).not.toHaveBeenCalled();
    request.mockResolvedValueOnce(Response.json({ status: "approved", orderStatus: "paid" }));
    await watch.check();
    expect(onResult).toHaveBeenCalledWith({ status: "approved", orderStatus: "paid" }, "p");
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
