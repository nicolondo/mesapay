"use client";

import { useCallback, useMemo } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { OPEN_PARAM, openAll, parseOpen, toggleOpen, withOpen } from "@/lib/erp/reports/drillState";

/**
 * Qué renglones de un reporte desplegable están abiertos, guardado en la
 * URL (`?abrir=inc,inc-ventas-8`, ver `drillState.ts`).
 *
 * Se escribe con `window.history.replaceState`, que Next integra con
 * `useSearchParams` SIN volver a pedir la página al servidor: abrir un
 * renglón no recalcula el reporte. Al salir a un documento y volver con
 * «atrás», la URL trae lo desplegado y el reporte reabre igual; compartir
 * el enlace comparte lo desplegado. `replace` (no `push`) para que «atrás»
 * salga del reporte en vez de ir cerrando renglón por renglón.
 */
export function useDrillOpen(param: string = OPEN_PARAM) {
  const pathname = usePathname();
  const search = useSearchParams();
  const raw = search.get(param);
  const open = useMemo(() => parseOpen(raw), [raw]);

  const commit = useCallback(
    (next: Set<string>) => {
      window.history.replaceState(null, "", `${pathname}${withOpen(window.location.search, next, param)}${window.location.hash}`);
    },
    [pathname, param],
  );

  const isOpen = useCallback((id: string) => open.has(id), [open]);
  const toggle = useCallback((id: string) => commit(toggleOpen(open, id)), [commit, open]);
  const openMany = useCallback((ids: readonly string[]) => commit(openAll(open, ids)), [commit, open]);
  const closeAll = useCallback(() => commit(new Set()), [commit]);
  return { open, isOpen, toggle, openMany, closeAll };
}
