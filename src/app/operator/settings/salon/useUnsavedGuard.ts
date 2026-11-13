"use client";

import { useEffect } from "react";

/**
 * No perder trabajo: mientras `dirty` sea true, avisa antes de salir.
 *
 *  - Recargar / cerrar la pestaña → el aviso nativo del navegador
 *    (`beforeunload`).
 *  - Navegar dentro de la app (menú lateral, «← Configuración», cualquier
 *    enlace) → una confirmación. Next no trae un «bloqueo de navegación»,
 *    así que se intercepta el clic en la fase de captura de `window`,
 *    ANTES de que lo vea el <Link>: si la persona cancela, el clic no
 *    llega y no se navega.
 *
 * El botón Atrás del navegador no se puede interceptar de forma fiable;
 * para ese caso el editor guarda un borrador local (ver FloorPlanEditor).
 */
export function useUnsavedGuard(dirty: boolean, message: string) {
  useEffect(() => {
    if (!dirty) return;

    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
    }

    function onClick(e: MouseEvent) {
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const target = e.target as Element | null;
      const a = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a) return;
      if (a.target && a.target !== "_self") return;
      if (a.hasAttribute("download")) return;
      const href = a.getAttribute("href") ?? "";
      if (href.startsWith("#")) return;
      let url: URL;
      try {
        url = new URL(a.href, window.location.href);
      } catch {
        return;
      }
      // Misma página (solo cambia el ancla): no se pierde nada.
      if (
        url.origin === window.location.origin &&
        url.pathname === window.location.pathname &&
        url.search === window.location.search
      ) {
        return;
      }
      if (!window.confirm(message)) {
        e.preventDefault();
        e.stopPropagation();
      }
    }

    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("click", onClick, true);
    };
  }, [dirty, message]);
}
