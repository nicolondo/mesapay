"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { useVisibleEventSource } from "@/lib/useVisibleEventSource";
import { useBatchedRefresh } from "@/lib/useBatchedRefresh";
import { isRefreshMessage } from "@/lib/liveRefresh";

/**
 * SSE live-refresh para las pantallas del operador.
 *
 * Agrupa los eventos de una misma ráfaga y sólo trabaja con la pestaña
 * visible. Cada reconexión recupera el estado actual una vez.
 */
export function LiveRefresh({ tenantSlug }: { tenantSlug: string }) {
  const router = useRouter();
  const [, startTx] = useTransition();
  const refresh = useBatchedRefresh(() => startTx(() => router.refresh()), tenantSlug);

  useVisibleEventSource(
    `/api/tenant/${tenantSlug}/events`,
    (es) =>
      es.addEventListener("message", (event) => {
        if (isRefreshMessage(event.data)) refresh();
      }),
    refresh,
  );

  return null;
}
