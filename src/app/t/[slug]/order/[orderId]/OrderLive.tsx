"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export function OrderLive({
  orderId,
  tenantSlug,
  initialStatus,
}: {
  orderId: string;
  tenantSlug: string;
  initialStatus: string;
}) {
  const router = useRouter();
  const [status] = useState(initialStatus);

  useEffect(() => {
    const es = new EventSource(`/api/tenant/${tenantSlug}/events`);
    es.addEventListener("message", (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.orderId === orderId) {
          router.refresh();
        }
      } catch {
        // ignore
      }
    });
    es.onerror = () => {
      // Browser will auto-reconnect on 200/end of stream.
    };
    return () => es.close();
  }, [orderId, tenantSlug, router]);

  return (
    <div className="mt-3 text-sm text-muted">
      Estado en vivo: <span className="text-ink font-medium">{label(status)}</span>
    </div>
  );
}

function label(s: string) {
  const map: Record<string, string> = {
    open: "Abierto",
    placed: "Enviado a cocina",
    in_kitchen: "Preparando",
    ready: "Listo para servir",
    served: "Servido",
    paying: "Cobrando",
    paid: "Pagado",
    cancelled: "Cancelado",
  };
  return map[s] ?? s;
}
