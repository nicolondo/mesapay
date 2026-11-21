// Only the token travels with the browser history entry. Positions belong to
// this mount, even when two entries have the same URL.
export type ScrollEntry = { href: string; top: number; from: string | null };

export function restoreScrollTop(panel: HTMLElement, top: number) {
  const apply = () => {
    const reachable = Math.min(top, Math.max(0, panel.scrollHeight - panel.clientHeight));
    if (panel.scrollTop !== reachable) panel.scrollTop = reachable;
    return panel.scrollTop;
  };
  let applied = apply();
  if (Math.abs(applied - top) < 1) return;

  // Give a streamed list time to replace its loading fallback. A later SSE
  // refresh must never pull the operator back toward an obsolete position.
  const listeners = new AbortController();
  const observer = new MutationObserver(() => {
    // A focus change or a scrollbar drag may precede its queued scroll event.
    if (panel.scrollTop !== applied) return stop();
    applied = apply();
    if (Math.abs(applied - top) < 1) stop();
  });
  const deadline = setTimeout(stop, 1500);
  function stop() {
    clearTimeout(deadline);
    observer.disconnect();
    listeners.abort();
  }

  const options = { passive: true, signal: listeners.signal };
  panel.addEventListener("scroll", () => {
    if (panel.scrollTop !== applied) stop();
  }, options);
  for (const type of ["wheel", "touchstart", "keydown", "pointerdown"]) {
    panel.addEventListener(type, stop, options);
  }
  observer.observe(panel, { childList: true, subtree: true });
  return stop;
}
