"use client";

import { useEffect, useRef } from "react";

/**
 * Watchdog de builds viejos. Una pestaña/PWA abierta NO toma el código de un
 * deploy nuevo hasta recargar — y eso nos ha producido bugs "imposibles"
 * (fixes desplegados que el usuario no ve, p. ej. la búsqueda del CRM).
 *
 * Compara el buildId embebido en el SSR con el que sirve /api/version y
 * recarga la página cuando difieren. Solo chequea en momentos seguros —
 * al ocultarse la pestaña o al volver a ella — nunca con un timer en plena
 * interacción, para no perder formularios a mitad de camino.
 */
export function StaleBuildReload({ buildId }: { buildId: string }) {
  const lastCheckRef = useRef(0);
  const reloadingRef = useRef(false);

  useEffect(() => {
    if (buildId === "dev") return;

    async function check() {
      const now = Date.now();
      if (reloadingRef.current || now - lastCheckRef.current < 60_000) return;
      lastCheckRef.current = now;
      try {
        const res = await fetch("/api/version", { cache: "no-store" });
        const json = (await res.json()) as { buildId?: string };
        if (json.buildId && json.buildId !== buildId) {
          reloadingRef.current = true;
          window.location.reload();
        }
      } catch {
        // Sin red — se reintenta en la próxima transición de visibilidad.
      }
    }

    // Ambos momentos son seguros: al ocultarse (el usuario no está mirando)
    // y al volver (acaba de llegar, no hay nada a medio escribir).
    function onVisibilityChange() {
      check();
    }
    function onFocus() {
      check();
    }

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onFocus);
    };
  }, [buildId]);

  return null;
}
