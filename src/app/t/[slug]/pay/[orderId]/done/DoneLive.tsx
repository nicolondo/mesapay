"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Refreshes the done page whenever the shared order changes. Used by both
 * counter-mode (to flip the "En preparación" card to "¡Listo!") and
 * table-mode (to roll in partial payments from other diners at the table).
 */
export function DoneLive({
  orderId,
  tenantSlug,
}: {
  orderId: string;
  tenantSlug: string;
}) {
  const router = useRouter();

  useEffect(() => {
    const es = new EventSource(`/api/tenant/${tenantSlug}/events`);
    const onMsg = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.orderId !== orderId) return;
        if (
          data.type === "order.ready" ||
          data.type === "order.updated" ||
          data.type === "order.paid"
        ) {
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
