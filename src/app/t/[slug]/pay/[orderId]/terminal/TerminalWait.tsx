"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { fmtCOP } from "@/lib/format";
import { useVisibleEventSource } from "@/lib/useVisibleEventSource";
import { TERMINAL_CANCELED_REASON, type TerminalAttemptView } from "@/lib/payments/terminalAttempt";
import { TerminalAttemptActions } from "@/components/payments/TerminalAttemptActions";

type Status = "pending" | "approved" | "declined" | "refunded";

/** A confirmed payment can be only one part of the still-open account. */
export function terminalReturnHref(
  status: Status,
  orderStatus: string,
  doneHref: string,
  continueHref: string | undefined,
  retryHref: string,
  canceledHref: string = retryHref,
  declineReason?: string | null,
): string | null {
  if (status === "approved") return orderStatus === "paid" || !continueHref ? doneHref : continueHref;
  if (status === "declined" && declineReason === TERMINAL_CANCELED_REASON) return canceledHref;
  if (status === "declined" || status === "refunded") return retryHref;
  return null;
}

type PaymentState = {
  status: Status;
  orderStatus: string;
  /** Se canceló en el datáfono (o el staff cerró el intento que no aprobó). */
  declineReason: string | null;
  /** El staff reintentó: el pago nuevo que hay que seguir. */
  nextPaymentId: string | null;
  /** Sólo para el staff: qué se sabe del intento enviado al datáfono. */
  terminalAttempt: TerminalAttemptView | null;
};

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
  canceledHref,
  initialDeclineReason = null,
  initialNextPaymentId = null,
  initialAttempt = null,
  canResolveTerminal = false,
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
  /** A dónde volver si se canceló en el datáfono (los métodos, con su aviso). */
  canceledHref?: string;
  initialDeclineReason?: string | null;
  initialNextPaymentId?: string | null;
  /** Sólo staff: el intento enviado al datáfono, para reintentar / cancelar. */
  initialAttempt?: TerminalAttemptView | null;
  /** Staff administrador: "Resolver cobro" si el datáfono no respondió. */
  canResolveTerminal?: boolean;
}) {
  const router = useRouter();
  const t = useTranslations("wait");
  const [{ status, orderStatus, declineReason, nextPaymentId, terminalAttempt }, setPayment] =
    useState<PaymentState>({
      status: initialStatus,
      orderStatus: initialOrderStatus,
      declineReason: initialDeclineReason,
      nextPaymentId: initialNextPaymentId,
      terminalAttempt: initialAttempt,
    });
  const redirected = useRef(false);
  const canceled = status === "declined" && declineReason === TERMINAL_CANCELED_REASON;

  useEffect(() => {
    if (redirected.current) return;
    // El staff reintentó en el datáfono: seguimos esperando, ahora el pago
    // nuevo (misma pantalla, otro `pid`).
    if (status === "declined" && nextPaymentId) {
      redirected.current = true;
      const url = new URL(window.location.href);
      url.searchParams.set("pid", nextPaymentId);
      router.replace(`${url.pathname}${url.search}`);
      return;
    }
    const href = terminalReturnHref(
      status,
      orderStatus,
      doneHref,
      continueHref,
      retryHref,
      canceledHref ?? retryHref,
      declineReason,
    );
    if (!href) return;
    const timer = setTimeout(() => {
      redirected.current = true;
      router.push(href);
    }, status === "approved" ? 1200 : 1500);
    return () => clearTimeout(timer);
  }, [status, orderStatus, declineReason, nextPaymentId, router, doneHref, continueHref, retryHref, canceledHref]);

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
      const j = (await r.json()) as {
        status: Status;
        orderStatus: string;
        declineReason?: string;
        nextPaymentId?: string;
        terminalAttempt?: TerminalAttemptView | null;
      };
      if (aliveRef.current) {
        setPayment((prev) => ({
          status: j.status,
          orderStatus: j.orderStatus,
          declineReason: j.declineReason ?? null,
          nextPaymentId: j.nextPaymentId ?? null,
          // Sólo el staff lo recibe; si no viene, se conserva lo que había.
          terminalAttempt: j.terminalAttempt !== undefined ? j.terminalAttempt : prev.terminalAttempt,
        }));
      }
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

  if (status === "declined" && nextPaymentId) {
    // Reintento en el datáfono: transitorio, el useEffect cambia de pago.
    return (
      <main className="flex flex-1 items-center justify-center px-6 py-16 bg-bone">
        <p className="text-muted text-sm">{t("terminalRetrying")}</p>
      </main>
    );
  }

  if (canceled) {
    // Se canceló en el datáfono: no se cobró. Vuelve a los métodos con su
    // aviso (?declined=canceled), no con "Pago rechazado".
    return (
      <main className="flex flex-1 items-center justify-center px-6 py-16 bg-bone">
        <div className="text-center max-w-sm">
          <div className="w-14 h-14 rounded-full bg-terracotta/15 text-terracotta mx-auto flex items-center justify-center font-display text-3xl">
            {"↺"}
          </div>
          <h1 className="font-display text-3xl tracking-[-0.015em] mt-4">
            {t("terminalCanceledTitle")}
          </h1>
          <p className="text-muted mt-2 text-sm">{t("terminalCanceledBody")}</p>
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

        {/* Sólo el staff: qué hacer si el datáfono no aprueba (cancelar en
            el equipo, reintentar, cobrar de otra forma, resolver). */}
        {continueHref && terminalAttempt && (
          <div className="mt-6 text-left bg-paper border border-hairline rounded-2xl p-4">
            <TerminalAttemptActions
              paymentId={paymentId}
              amountCents={amountCents}
              attempt={terminalAttempt}
              pushedAt={terminalAttempt.pushedAt}
              tenantSlug={tenantSlug}
              canResolve={canResolveTerminal}
              onChanged={() => refetch()}
            />
          </div>
        )}
      </div>
    </main>
  );
}
