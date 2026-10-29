"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { fmtCOP } from "@/lib/format";
import { useVisibleEventSource } from "@/lib/useVisibleEventSource";

type Status = "pending" | "approved" | "declined" | "refunded";

/** A confirmed payment can be only one part of the still-open account. */
export function terminalReturnHref(
  status: Status,
  orderStatus: string,
  doneHref: string,
  continueHref: string | undefined,
  retryHref: string,
): string | null {
  if (status === "approved") return orderStatus === "paid" || !continueHref ? doneHref : continueHref;
  if (status === "declined" || status === "refunded") return retryHref;
  return null;
}

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
  paymentId,
  amountCents,
  initialStatus,
  initialOrderStatus,
  doneHref,
  continueHref,
  retryHref,
}: {
  tenantSlug: string;
  tenantName: string;
  locationLabel: string;
  orderId: string;
  paymentId: string;
  amountCents: number;
  initialStatus: Status;
  initialOrderStatus: string;
  // A dónde ir al APROBARSE (lo resuelve el server según quién cobra).
  doneHref: string;
  continueHref?: string;
  retryHref: string;
}) {
  const router = useRouter();
  const t = useTranslations("wait");
  const [{ status, orderStatus }, setPayment] = useState({ status: initialStatus, orderStatus: initialOrderStatus });
  const redirected = useRef(false);

  useEffect(() => {
    const href = terminalReturnHref(status, orderStatus, doneHref, continueHref, retryHref);
    if (!href || redirected.current) return;
    const timer = setTimeout(() => {
      redirected.current = true;
      router.push(href);
    }, status === "approved" ? 1200 : 1500);
    return () => clearTimeout(timer);
  }, [status, orderStatus, router, doneHref, continueHref, retryHref]);

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
      const j = (await r.json()) as { status: Status; orderStatus: string };
      if (aliveRef.current) setPayment({ status: j.status, orderStatus: j.orderStatus });
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
