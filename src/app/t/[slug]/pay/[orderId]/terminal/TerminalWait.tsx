"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { fmtCOP } from "@/lib/format";
import { useVisibleEventSource } from "@/lib/useVisibleEventSource";

type Status = "pending" | "approved" | "declined" | "refunded";

/**
 * Waiting screen the diner sees after tapping "Tarjeta con datáfono". We
 * sit on this page until the terminal returns a result (via SSE) or the
 * payment polls into approved/declined. Same pattern as CashWait — just
 * different copy.
 */
export function TerminalWait({
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
  const t = useTranslations("wait");
  const [status, setStatus] = useState<Status>(initialStatus);
  const redirected = useRef(false);

  useEffect(() => {
    if (status === "approved" && !redirected.current) {
      redirected.current = true;
      const t = setTimeout(() => {
        router.push(`/t/${tenantSlug}/pay/${orderId}/done?pid=${paymentId}`);
      }, 1200);
      return () => clearTimeout(t);
    }
    // Si declina, volvemos al checkout con un flag para mostrar
    // banner de error. Mejor UX que dejar al diner en una pantalla
    // sin salida — desde el checkout pueden reintentar con otro
    // método inmediatamente. Damos un beat (1.5s) para que vean el
    // X antes del redirect.
    if (
      (status === "declined" || status === "refunded") &&
      !redirected.current
    ) {
      redirected.current = true;
      const t = setTimeout(() => {
        router.push(`/t/${tenantSlug}/pay/${orderId}?declined=1`);
      }, 1500);
      return () => clearTimeout(t);
    }
  }, [status, router, tenantSlug, orderId, paymentId]);

  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  async function refetch() {
    try {
      const r = await fetch(`/api/tenant/${tenantSlug}/payment/${paymentId}`);
      if (!r.ok) return;
      const j = (await r.json()) as { status: Status };
      if (aliveRef.current) setStatus(j.status);
    } catch {}
  }

  // SSE visibility-aware + poll de respaldo. Si el diner bloquea el
  // teléfono mientras el cajero pasa el datáfono, al desbloquear
  // onResume refetcha el estado al instante.
  useVisibleEventSource(
    `/api/tenant/${tenantSlug}/events`,
    (es) => es.addEventListener("message", () => refetch()),
    () => refetch(),
  );

  useEffect(() => {
    const poll = setInterval(() => refetch(), 4000);
    return () => clearInterval(poll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantSlug, paymentId]);

  if (status === "approved") {
    return (
      <main className="flex flex-1 items-center justify-center px-6 py-16 bg-bone">
        <div className="text-center max-w-sm">
          <div className="w-14 h-14 rounded-full bg-ok/20 text-ok mx-auto flex items-center justify-center font-display text-3xl check-pop">
            {"✓"}
          </div>
          <h1 className="font-display text-4xl tracking-[-0.015em] mt-5">
            {t("terminalApprovedTitle")}
          </h1>
          <p className="text-muted mt-3">{t("terminalApprovedBody")}</p>
        </div>
      </main>
    );
  }

  if (status === "declined" || status === "refunded") {
    // Pantalla transitoria — el useEffect redirige a checkout en
    // 1.5s con ?declined=1 para que el cliente pueda reintentar
    // con otro método.
    return (
      <main className="flex flex-1 items-center justify-center px-6 py-16 bg-bone">
        <div className="text-center max-w-sm">
          <div className="w-14 h-14 rounded-full bg-danger/20 text-danger mx-auto flex items-center justify-center font-display text-3xl">
            {"✕"}
          </div>
          <h1 className="font-display text-3xl tracking-[-0.015em] mt-4">
            {t("declinedTitle")}
          </h1>
          <p className="text-muted mt-2 text-sm">{t("terminalDeclinedBody")}</p>
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
              💳
            </span>
          </div>
        </div>
        <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-muted mt-6">
          {locationLabel} · {tenantName}
        </div>
        <h1 className="font-display text-4xl tracking-[-0.015em] mt-2">
          {t("terminalWaitTitle")}
        </h1>
        <p className="text-muted mt-3">
          {t.rich("terminalWaitBody", {
            amount: fmtCOP(amountCents),
            b: (chunks) => (
              <span className="font-mono tabular text-ink">{chunks}</span>
            ),
          })}
        </p>

        <div className="mt-8 bg-paper border border-hairline rounded-2xl p-5 text-left">
          <div className="flex items-baseline justify-between">
            <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
              {t("totalToPay")}
            </span>
            <span className="font-display text-3xl">
              {fmtCOP(amountCents)}
            </span>
          </div>
          <p className="mt-3 text-xs text-muted-2">{t("terminalWaitHint")}</p>
        </div>

        <div className="mt-6 flex items-center justify-center gap-2 text-xs text-muted-2">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-terracotta animate-pulse" />
          {t("waitingTerminal")}
        </div>
      </div>
    </main>
  );
}
