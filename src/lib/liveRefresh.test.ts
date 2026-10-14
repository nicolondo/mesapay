import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRefreshBatch, isRefreshMessage } from "./liveRefresh";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("live refresh messages", () => {
  it.each(['{"type":"hello"}', '{}', 'null', '[]', '3', '{"type":false}', 'not json'])("does not refresh for transport/control data %s", data => {
    expect(isRefreshMessage(data)).toBe(false);
  });
  it.each(["order.updated", "order.ready", "order.paid", "order.round_cancelled", "cash.updated", "payment.approved", "ticket.printable"])("keeps %s updates", type => {
    expect(isRefreshMessage(JSON.stringify({ type, orderId: "fixture" }))).toBe(true);
  });
});

describe("bounded refresh batches", () => {
  it("coalesces a transaction's many events into one request", () => {
    const refresh = vi.fn();
    const batch = createRefreshBatch(refresh);
    for (let i = 0; i < 100; i++) batch.request();
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.runAllTimers();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it("retains the final change instead of dropping it during the batch", () => {
    let value = "before";
    const snapshots: string[] = [];
    const batch = createRefreshBatch(() => snapshots.push(value));
    batch.request();
    vi.advanceTimersByTime(249);
    value = "last change";
    batch.request();
    vi.advanceTimersByTime(1);
    expect(snapshots).toEqual(["last change"]);
  });
  it("does not postpone updates indefinitely under continuous traffic", () => {
    const refresh = vi.fn();
    const batch = createRefreshBatch(refresh);
    for (let i = 0; i < 10; i++) {
      batch.request();
      vi.advanceTimersByTime(100);
    }
    expect(refresh).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(250);
    expect(refresh).toHaveBeenCalledTimes(4);
  });
  it("allows a later event after a batch completed", () => {
    const refresh = vi.fn();
    const batch = createRefreshBatch(refresh);
    batch.request();
    vi.advanceTimersByTime(250);
    batch.request();
    vi.advanceTimersByTime(250);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
  it("can cancel work when hidden and resume with a new snapshot", () => {
    const refresh = vi.fn();
    const batch = createRefreshBatch(refresh);
    batch.request();
    batch.cancel();
    vi.advanceTimersByTime(1000);
    expect(refresh).not.toHaveBeenCalled();
    batch.request();
    vi.advanceTimersByTime(250);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it("disposes pending work and rejects queued callbacks after unmount", () => {
    const refresh = vi.fn();
    const batch = createRefreshBatch(refresh);
    batch.request();
    batch.dispose();
    batch.dispose();
    batch.request();
    vi.runAllTimers();
    expect(refresh).not.toHaveBeenCalled();
  });
  it("schedules events arriving while the current refresh starts", () => {
    const refresh = vi.fn(() => { if (refresh.mock.calls.length === 1) batch.request(); });
    const batch = createRefreshBatch(refresh);
    batch.request();
    vi.advanceTimersByTime(500);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
