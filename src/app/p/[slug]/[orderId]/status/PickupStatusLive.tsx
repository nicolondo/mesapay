"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export function PickupStatusLive({
  orderId,
  tenantSlug,
  readyEtaIso,
  etaMinutes,
  isReady,
  isServed,
}: {
  orderId: string;
  tenantSlug: string;
  readyEtaIso: string | null;
  etaMinutes: number;
  isReady: boolean;
  isServed: boolean;
}) {
  const router = useRouter();
  const [remaining, setRemaining] = useState<number>(() =>
    computeRemaining(readyEtaIso),
  );

  // Tick the countdown every 10s so the customer sees the wait shrink. The
  // authoritative ETA was frozen at payment time on the server; we just
  // decrement locally for UX.
  useEffect(() => {
    if (isReady) return;
    const t = setInterval(() => {
      setRemaining(computeRemaining(readyEtaIso));
    }, 10_000);
    return () => clearInterval(t);
  }, [readyEtaIso, isReady]);

  // Live updates: when the kitchen flips the round to ready, refresh so the
  // server-rendered state reflects it.
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
        // ignore
      }
    };
    es.addEventListener("message", onMsg);
    return () => {
      es.removeEventListener("message", onMsg);
      es.close();
    };
  }, [orderId, tenantSlug, router]);

  if (isServed) {
    return (
      <div className="mt-6 rounded-2xl bg-ink text-bone p-6 text-center">
        <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-bone/70">
          Entregado
        </div>
        <div className="font-display text-3xl mt-2">Gracias por comer con nosotros</div>
      </div>
    );
  }

  if (isReady) {
    return (
      <div className="mt-6 rounded-2xl bg-ok text-bone p-8 text-center">
        <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-bone/80">
          ¡Tu pedido está listo!
        </div>
        <div className="font-display text-4xl mt-2 leading-[1.05]">
          Pasa por el mostrador
        </div>
        <div className="text-sm text-bone/80 mt-3">
          Muestra el código al cajero.
        </div>
      </div>
    );
  }

  const mins = Math.max(0, Math.round(remaining / 60));
  return (
    <div className="mt-6 rounded-2xl bg-paper border border-hairline p-6 text-center">
      <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-muted">
        Tiempo estimado
      </div>
      <div className="font-display text-6xl leading-none mt-3 tabular">
        {mins} <span className="text-2xl text-muted">min</span>
      </div>
      <div className="text-sm text-muted mt-3">
        Te avisamos en esta pantalla cuando esté listo.
      </div>
      <div className="mt-4 h-1.5 rounded-full bg-hairline overflow-hidden">
        <div
          className="h-full bg-terracotta transition-all duration-500"
          style={{
            width: `${Math.max(
              6,
              Math.min(
                100,
                etaMinutes > 0
                  ? ((etaMinutes * 60 - remaining) / (etaMinutes * 60)) * 100
                  : 0,
              ),
            )}%`,
          }}
        />
      </div>
    </div>
  );
}

function computeRemaining(iso: string | null): number {
  if (!iso) return 0;
  return Math.max(0, Math.floor((new Date(iso).getTime() - Date.now()) / 1000));
}
