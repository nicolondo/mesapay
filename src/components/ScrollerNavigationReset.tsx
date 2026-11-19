"use client";

import { useLayoutEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { restoreScrollTop, type ScrollEntry } from "./scrollerHistory";

export function ScrollerNavigationReset({ scrollerId }: { scrollerId: string }) {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const entries = useRef(new Map<string, ScrollEntry>());
  const current = useRef<ScrollEntry | null>(null);
  const popped = useRef<string | null>(null);
  const clicked = useRef<HTMLAnchorElement | null>(null);

  useLayoutEffect(() => {
    const onPop = () => {
      popped.current = location.href;
      clicked.current = null;
    };
    window.addEventListener("popstate", onPop, true);
    return () => window.removeEventListener("popstate", onPop, true);
  }, []);

  useLayoutEffect(() => {
    const panel = document.getElementById(scrollerId);
    if (!panel) return;
    const href = location.pathname + location.search;
    const previous = current.current;
    const samePath = previous?.href.split("?")[0] === pathname;
    const saved = popped.current === location.href
      ? entries.current.get(history.state?.mpScrollId)
      : undefined;
    const from = clicked.current?.href === location.href ? previous?.href.split("?")[0] : null;
    const entry = saved?.href === href ? saved : {
      href, from: from ?? null, top: samePath ? panel.scrollTop : 0,
    };
    // The registry belongs to this mount. Never reuse a token left by a
    // different document (including after a hard reload).
    const id = entry === saved ? history.state.mpScrollId : Array.from(crypto.getRandomValues(new Uint32Array(4))).join("-");
    entries.current.set(id, entry);
    current.current = entry;
    clicked.current = null;
    popped.current = null;

    const markEntry = () => history.replaceState({
      ...history.state, mpScrollId: id, mpScrollFrom: entry.from,
    }, "");
    markEntry();
    const stop = previous && (entry === saved || !samePath)
      ? restoreScrollTop(panel, entry.top, retry => {
          const observer = new MutationObserver(retry);
          observer.observe(panel, { childList: true, subtree: true });
          return () => observer.disconnect();
        })
      : () => {};
    const onScroll = () => { entry.top = panel.scrollTop; };
    // Save while the outgoing list still owns the panel. After the route
    // commit the shorter detail may already have clamped scrollTop to zero.
    const onClick = (event: MouseEvent) => {
      clicked.current = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (clicked.current) {
        popped.current = null;
        onScroll();
        // A router refresh can replace custom history state.
        if (history.state?.mpScrollId !== id) markEntry();
      }
    };
    panel.addEventListener("scroll", onScroll);
    document.addEventListener("click", onClick, true);
    for (const type of ["wheel", "touchstart", "keydown", "pointerdown"]) panel.addEventListener(type, stop);
    return () => {
      stop();
      panel.removeEventListener("scroll", onScroll);
      document.removeEventListener("click", onClick, true);
      for (const type of ["wheel", "touchstart", "keydown", "pointerdown"]) panel.removeEventListener(type, stop);
    };
  }, [pathname, search, scrollerId]);

  return null;
}
