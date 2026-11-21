import { afterEach, describe, expect, it, vi } from "vitest";
import { restoreScrollTop } from "./scrollerHistory";

function fixture(height = 1500) {
  const panel = Object.assign(new EventTarget(), {
    scrollTop: 0, scrollHeight: height, clientHeight: 100,
  });
  let mutation: (() => void) | undefined;
  const disconnect = vi.fn(() => { mutation = undefined; });
  vi.stubGlobal("MutationObserver", class {
    constructor(retry: () => void) { mutation = retry; }
    observe() {}
    disconnect = disconnect;
  });
  const listen = vi.spyOn(panel, "addEventListener");
  const restore = () => restoreScrollTop(panel as HTMLElement, 987);
  return { panel, restore, listen, disconnect, refresh: () => mutation?.() };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("restoreScrollTop", () => {
  it("restores immediately without installing input listeners", () => {
    const { panel, restore, listen } = fixture();
    expect(restore()).toBeUndefined();
    expect(panel.scrollTop).toBe(987);
    expect(listen).not.toHaveBeenCalled();
  });

  it("ignores its own scroll event and restores after the loading fallback grows", () => {
    const { panel, restore, listen, refresh, disconnect } = fixture(200);
    restore();
    expect(panel.scrollTop).toBe(100);
    expect(listen).toHaveBeenCalledWith("touchstart", expect.any(Function), expect.objectContaining({ passive: true }));
    panel.dispatchEvent(new Event("scroll"));
    panel.scrollHeight = 2000;
    refresh();
    expect(panel.scrollTop).toBe(987);
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("stops retrying an unreachable offset even when SSE keeps refreshing", () => {
    vi.useFakeTimers();
    const { panel, restore, refresh, disconnect } = fixture(200);
    restore();
    for (let i = 0; i < 8; i++) {
      vi.advanceTimersByTime(250);
      refresh();
    }
    expect(disconnect).toHaveBeenCalledOnce();
    panel.scrollHeight = 2000;
    refresh();
    expect(panel.scrollTop).toBe(100);
  });

  it.each(["scroll", "mutation"])("respects an external movement detected by %s", event => {
    const { panel, restore, refresh, disconnect } = fixture(200);
    restore();
    panel.scrollTop = 23;
    if (event === "scroll") panel.dispatchEvent(new Event("scroll"));
    refresh();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(panel.scrollTop).toBe(23);
  });
});
