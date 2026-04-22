"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fmtCOP } from "@/lib/format";

type Status = "pending" | "approved" | "declined" | "refunded";

export function CashWait({
  tenantSlug,
  tenantName,
  locationLabel,
  orderId,
  paymentId,
  amountCents,
  initialStatus,
}: {
  tenantSlug: string;
  tenantName: string;
  locationLabel: string;
  orderId: string;
  paymentId: string;
  amountCents: number;
  initialStatus: Status;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>(initialStatus);
  const redirected = useRef(false);

  useEffect(() => {
    if (status === "approved" && !redirected.current) {
      redirected.current = true;
      const t = setTimeout(() => {
        router.push(
          `/t/${tenantSlug}/pay/${orderId}/done?pid=${paymentId}`,
        );
      }, 1200);
      return () => clearTimeout(t);
    }
  }, [status, router, tenantSlug, orderId]);

  useEffect(() => {
    let alive = true;

    async function refetch() {
      try {
        const r = await fetch(`/api/tenant/${tenantSlug}/payment/${paymentId}`);
        if (!r.ok) return;
        const j = (await r.json()) as { status: Status };
        if (alive) setStatus(j.status);
      } catch {}
    }

    const es = new EventSource(`/api/tenant/${tenantSlug}/events`);
    es.addEventListener("message", () => {
      refetch();
    });

    const poll = setInterval(refetch, 5000);

    return () => {
      alive = false;
      es.close();
      clearInterval(poll);
    };
  }, [tenantSlug, paymentId]);

  if (status === "approved") {
    return (
      <main className="flex flex-1 items-center justify-center px-6 py-16 bg-bone">
        <div className="text-center max-w-sm">
          <div className="w-14 h-14 rounded-full bg-ok/20 text-ok mx-auto flex items-center justify-center font-display text-3xl check-pop">
            ✓
          </div>
          <h1 className="font-display text-4xl tracking-[-0.015em] mt-5">
            ¡Pago recibido!
          </h1>
          <p className="text-muted mt-3">
            Gracias por visitarnos. Esperamos verte pronto.
          </p>
        </div>
      </main>
    );
  }

  if (status === "declined" || status === "refunded") {
    return (
      <main className="flex flex-1 items-center justify-center px-6 py-16 bg-bone">
        <div className="text-center max-w-sm">
          <h1 className="font-display text-3xl tracking-[-0.015em]">
            Pago cancelado
          </h1>
          <p className="text-muted mt-2">
            Tu solicitud de pago en efectivo fue cancelada. Puedes volver a
            intentarlo.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex flex-1 items-center justify-center px-6 py-12 bg-bone">
      <div className="text-center max-w-sm">
        <div className="relative w-20 h-20 mx-auto">
          <div className="absolute inset-0 rounded-full bg-terracotta/15 animate-ping" />
          <div className="absolute inset-2 rounded-full bg-terracotta/25" />
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-3xl" aria-hidden>
              🛎
            </span>
          </div>
        </div>
        <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-muted mt-6">
          {locationLabel} · {tenantName}
        </div>
        <h1 className="font-display text-4xl tracking-[-0.015em] mt-2">
          El mesero viene a cobrar
        </h1>
        <p className="text-muted mt-3">
          Ya avisamos a tu mesero. Prepara{" "}
          <span className="font-mono tabular text-ink">
            {fmtCOP(amountCents)}
          </span>{" "}
          y espera un momento en tu mesa.
        </p>

        <div className="mt-8 bg-paper border border-hairline rounded-2xl p-5 text-left">
          <div className="flex items-baseline justify-between">
            <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
              Total a pagar
            </span>
            <span className="font-display text-3xl">
              {fmtCOP(amountCents)}
            </span>
          </div>
          <p className="mt-3 text-xs text-muted-2">
            Cuando el mesero confirme el pago, esta pantalla se actualiza sola.
          </p>
        </div>

        <div className="mt-6 flex items-center justify-center gap-2 text-xs text-muted-2">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-terracotta animate-pulse" />
          Esperando cobro…
        </div>
      </div>
    </main>
  );
}
