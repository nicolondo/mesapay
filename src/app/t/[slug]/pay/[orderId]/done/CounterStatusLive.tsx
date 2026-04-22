"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function CounterStatusLive({
  orderId,
  tenantSlug,
}: {
  orderId: string;
  tenantSlug: string;
}) {
  const router = useRouter();

  // Live updates: when the kitchen advances the round, refresh so the server
  // re-renders with the new status. Same pattern as the pickup status page.
  useEffect(() => {
    const es = new EventSource(`/api/tenant/${tenantSlug}/events`);
    const onMsg = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.orderId !== orderId) return;
        if (data.type === "order.ready" || data.type === "order.updated") {
          router.refresh();
          try {
            navigator.vibrate?.([140, 70, 140]);
          } catch {}
        }
      } catch {
        // ignore malformed events
      }
    };
    es.addEventListener("message", onMsg);
    return () => {
      es.removeEventListener("message", onMsg);
      es.close();
    };
  }, [orderId, tenantSlug, router]);

  return null;
}
