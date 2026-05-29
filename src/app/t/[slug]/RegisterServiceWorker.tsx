"use client";

import { useEffect } from "react";

/**
 * Registra el service worker silenciosamente para el flow del diner.
 * El SW (public/sw.js) hace cache-first sobre /_next/static/, así
 * que cuando el diner vuelve a abrir cualquier página el bundle de
 * @kushki/js y demás chunks pesados cargan instantáneo (vs ~1-3s en
 * 4G la primera vez).
 *
 * No-op silencioso si:
 *   - El browser no soporta service workers (browsers viejos).
 *   - El registro falla (red caída, certificado raro, etc).
 *
 * Idempotente — `register("/sw.js")` re-resuelve a la registración
 * existente sin reinstalar. Lo importante es llamarlo desde cualquier
 * página del flow diner para que el SW se active aunque arranquen en
 * /menu y nunca pasen por /pay.
 */
export function RegisterServiceWorker() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    // No bloqueamos el primer paint — fire-and-forget tras 1s para que
    // la carga inicial de la página tenga prioridad CPU/red.
    const id = window.setTimeout(() => {
      navigator.serviceWorker
        .register("/sw.js")
        .catch((err) =>
          console.warn("[sw] registro falló (no crítico)", err),
        );
    }, 1000);
    return () => window.clearTimeout(id);
  }, []);
  return null;
}
