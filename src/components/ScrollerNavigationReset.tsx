"use client";

import { useLayoutEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { restoreScrollTop, type ScrollEntry } from "./scrollerHistory";

/** Un enlace a otra ruta abre arriba. Atrás y Adelante restauran la posición
 * de esa entrada del historial. Cambiar sólo la query conserva el scroll. */
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
    const restoring = popped.current === location.href;
    const token = history.state?.mpScrollId;
    const saved = restoring ? entries.current.get(token) : undefined;
    const exact = saved?.href === href ? saved : undefined;
    // Next can replace the token during a refresh. Recover the latest offset
    // for the exact URL, but only trust navigation provenance from a token.
    const fallback = restoring && !token
      ? Array.from(entries.current.values()).reverse().find(candidate => candidate.href === href)
      : undefined;
    const from = clicked.current?.href === location.href ? previous?.href.split("?")[0] : null;
    const entry = exact ?? {
      href, from: from ?? null, top: fallback?.top ?? (samePath ? panel.scrollTop : 0),
    };
    const id = exact ? token : Array.from(crypto.getRandomValues(new Uint32Array(4))).join("-");
    const registry = entries.current;
    registry.delete(id);
    registry.set(id, entry);
    if (registry.size > 30) registry.delete(registry.keys().next().value!);
    current.current = entry;
    clicked.current = null;
    popped.current = null;

    const markEntry = () => history.replaceState({
      ...history.state, mpScrollId: id, mpScrollFrom: entry.from,
    }, "");
    markEntry();
    const stop = previous && (restoring || !samePath)
      ? restoreScrollTop(panel, entry.top)
      : undefined;
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
    return () => {
      stop?.();
      panel.removeEventListener("scroll", onScroll);
      document.removeEventListener("click", onClick, true);
    };
  }, [pathname, search, scrollerId]);

  return null;
}
