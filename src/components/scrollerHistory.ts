// Only the token travels with the browser history entry. Positions are
// scoped to the mounted shell, including when two entries have the same URL.
export type ScrollEntry = { href: string; top: number; from: string | null };

export function restoreScrollTop(
  panel: HTMLElement,
  top: number,
  observe: (retry: () => void) => () => void,
) {
  const apply = () => {
    panel.scrollTop = top;
    return Math.abs(panel.scrollTop - top) < 1;
  };
  if (apply()) return () => {};
  // A streamed loading fallback may be shorter than the saved position.
  const stop = observe(() => { if (apply()) stop(); });
  return stop;
}
