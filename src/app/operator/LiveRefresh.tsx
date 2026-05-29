"use client";

import { useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useVisibleEventSource } from "@/lib/useVisibleEventSource";

/**
 * SSE live-refresh para las pantallas del operador.
 *
 * La conexión es visibility-aware (ver useVisibleEventSource): sólo
 * está abierta con la pestaña visible, así no agotamos el cupo de ~6
 * conexiones HTTP/1.1 con pestañas en segundo plano.
 */
export function LiveRefresh({ tenantSlug }: { tenantSlug: string }) {
  const router = useRouter();
  const [, startTx] = useTransition();
  const lastRef = useRef(0);

  const refresh = () => startTx(() => router.refresh());

  useVisibleEventSource(
    `/api/tenant/${tenantSlug}/events`,
    (es) =>
      es.addEventListener("message", () => {
        const now = Date.now();
        if (now - lastRef.current < 800) return;
        lastRef.current = now;
        refresh();
      }),
    refresh,
  );

  return null;
}
