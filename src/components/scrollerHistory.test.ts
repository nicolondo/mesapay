import { describe, expect, it, vi } from "vitest";
import { restoreScrollTop } from "./scrollerHistory";

describe("restoreScrollTop", () => {
  it("restores immediately when the list is ready", () => {
    const panel = { scrollTop: 0 } as HTMLElement;
    const observe = vi.fn();
    restoreScrollTop(panel, 1942, observe);
    expect(panel.scrollTop).toBe(1942);
    expect(observe).not.toHaveBeenCalled();
  });

  it("retries the original offset after the loading fallback is replaced", () => {
    let height = 100;
    let offset = 0;
    const panel = {
      get scrollTop() { return offset; },
      set scrollTop(value) { offset = Math.min(height, value); },
    } as HTMLElement;
    const disconnect = vi.fn();
    const observe = vi.fn<(retry: () => void) => () => void>().mockReturnValue(disconnect);
    restoreScrollTop(panel, 987, observe);
    expect(offset).toBe(100);
    height = 1500;
    observe.mock.calls[0][0]();
    expect(offset).toBe(987);
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
