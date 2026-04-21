"use client";

import { useEffect, useRef, useState } from "react";
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
  const [toast, setToast] = useState<{ title: string; hint: string; tone: "ready" | "paid" } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function flash(
    title: string,
    hint: string,
    tone: "ready" | "paid",
  ) {
    setToast({ title, hint, tone });
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setToast(null), 9000);
    try {
      navigator.vibrate?.([140, 70, 140]);
    } catch {}
  }

  useEffect(() => {
    const es = new EventSource(`/api/tenant/${tenantSlug}/events`);
    const onMessage = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.orderId !== orderId) return;
        if (data.type === "order.ready") {
          flash("¡Algo está listo!", "Pronto llega a tu mesa.", "ready");
        } else if (data.type === "order.paid") {
          flash("Pago recibido", "¡Gracias por comer con nosotros!", "paid");
        }
        router.refresh();
      } catch {
        // ignore
      }
    };
    es.addEventListener("message", onMessage);
    es.onerror = () => {
      // Browser auto-reconnects.
    };
    return () => {
      es.removeEventListener("message", onMessage);
      es.close();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [orderId, tenantSlug, router]);

  return (
    <>
      <div className="mt-3 text-sm text-muted">
        Estado en vivo: <span className="text-ink font-medium">{label(status)}</span>
      </div>
      {toast && (
        <div
          role="status"
          aria-live="polite"
          className="fixed top-4 left-1/2 z-50 max-w-md w-[calc(100%-2rem)] slide-down"
        >
          <div className="bg-ink text-bone rounded-2xl shadow-[0_10px_40px_rgba(0,0,0,0.35)] px-4 py-3 flex items-center gap-3">
            <span
              className={
                "w-10 h-10 rounded-full inline-flex items-center justify-center shrink-0 " +
                (toast.tone === "ready"
                  ? "bg-[#C98A2E]/30"
                  : "bg-[#2E6B4C]/35")
              }
            >
              {toast.tone === "ready" ? <BellIcon /> : <CheckIcon />}
            </span>
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate">{toast.title}</div>
              <div className="text-[12px] text-bone/70 truncate">{toast.hint}</div>
            </div>
            <button
              type="button"
              onClick={() => setToast(null)}
              aria-label="Cerrar"
              className="shrink-0 text-bone/60 hover:text-bone w-8 h-8 rounded-full inline-flex items-center justify-center text-lg leading-none"
            >
              ×
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function BellIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12l5 5L20 7" />
    </svg>
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
