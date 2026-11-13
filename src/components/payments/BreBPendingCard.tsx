"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useApiError } from "@/lib/useApiError";
import { breBSecondsLeft, formatBreBCountdown, type BreBChargeView } from "@/lib/payments/breB/view";
import { BreBSheet } from "./BreBSheet";
import type { PendingPaymentView } from "./PendingPaymentNotice";

/**
 * Un cobro Bre-B EN CURSO, en los avisos de pagos pendientes del staff
 * (ficha de la mesa, pantalla de cobro, Salón). Mismas reglas que el
 * datáfono enviado: mientras el QR esté vivo es plata en vuelo y bloquea
 * cobrar esa parte por otro medio.
 *
 *   · «Ver código»: vuelve a mostrar el QR (en este dispositivo) para que el
 *     cliente lo escanee.
 *   · «Consultar estado»: le pregunta a Kushki ya y aplica el resultado
 *     real (aprobado, rechazado, vencido). Es lo que recupera un cobro que
 *     se quedó sin respuesta.
 *   · «Cancelar cobro»: invalida el QR en Kushki. La cuenta se libera sólo
 *     si Kushki lo confirma; si no, queda «sin confirmar».
 *
 * `chargeLocked` ("solo el administrador cobra" y quien mira es un mesero):
 * se ve el cobro pero no las acciones que lo cambian.
 */
export function BreBPendingCard({
  pending,
  amountLabel,
  methodLabel,
  tenantSlug,
  chargeLocked = false,
  disabled = false,
  onApproved,
  onChanged,
  reconcileHref = null,
}: {
  pending: PendingPaymentView;
  amountLabel: string;
  methodLabel: string;
  tenantSlug: string | null;
  chargeLocked?: boolean;
  disabled?: boolean;
  /** Se aprobó: `paid` = con este pago la cuenta quedó pagada del todo. */
  onApproved: (paid: boolean) => void;
  /** Cambió el estado (cancelado, rechazado, vencido): releer la cuenta. */
  onChanged: () => void;
  /**
   * Sin confirmar y quien mira es administrador: «Conciliar pago» lleva al
   * bloque de conciliación del detalle de la orden. null = no puede (se le
   * dice que se lo pida al administrador).
   */
  reconcileHref?: string | null;
}) {
  const t = useTranslations("breB");
  const tPending = useTranslations("pendingPayment");
  const apiError = useApiError();
  const [busy, setBusy] = useState<"check" | "cancel" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const uncertain = pending.breB?.state === "uncertain";
  const expiresAt = pending.breB?.state === "active" ? pending.breB.expiresAt : null;

  useEffect(() => {
    if (!expiresAt) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  const secondsLeft = breBSecondsLeft(expiresAt, nowMs);

  async function act(action: "check" | "cancel") {
    if (!tenantSlug || busy || disabled) return;
    if (action === "cancel" && !window.confirm(t("cancelConfirm"))) return;
    setBusy(action);
    setNote(null);
    try {
      const res = await fetch(`/api/tenant/${tenantSlug}/payment/${pending.id}/bre-b`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(action === "check" ? { action, force: true } : { action }),
      });
      const json = (await res.json().catch(() => ({}))) as { charge?: BreBChargeView; error?: string };
      if (!res.ok || !json.charge) {
        setNote(apiError(json, t("errNetwork")));
        return;
      }
      if (json.charge.state === "approved") onApproved(json.charge.orderPaid);
      else if (json.charge.state === "uncertain") setNote(t("stillUncertain"));
      else if (json.charge.state === "active") setNote(t("pending.stillWaiting"));
      else onChanged();
    } catch {
      setNote(t("errNetwork"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      className={`rounded-xl p-3 space-y-2 ${
        uncertain ? "border-2 border-terracotta/60 bg-terracotta/10" : "border border-op-border bg-op-bg"
      }`}
    >
      <div
        className={`font-mono text-[10px] tracking-wider uppercase ${uncertain ? "text-terracotta" : "text-op-muted"}`}
      >
        {uncertain ? t("pending.kickerUncertain") : t("pending.kicker")}
      </div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium">{methodLabel}</span>
        <span className="font-display text-xl tabular leading-none">{amountLabel}</span>
      </div>
      <p className="text-[11px] text-op-muted leading-snug">
        {uncertain
          ? t("pending.bodyUncertain")
          : secondsLeft != null
            ? t("pending.bodyActive", { time: formatBreBCountdown(secondsLeft) })
            : t("pending.bodyActiveNoTime")}
      </p>
      {tenantSlug && (
        <div className="flex flex-wrap gap-2 pt-1">
          {!uncertain && !chargeLocked && (
            <button
              type="button"
              onClick={() => setShowQr(true)}
              disabled={disabled || busy !== null}
              className="min-h-10 px-3 rounded-full bg-ink text-bone text-sm disabled:opacity-50"
            >
              {t("pending.showQr")}
            </button>
          )}
          <button
            type="button"
            onClick={() => act("check")}
            disabled={disabled || busy !== null}
            className="min-h-10 px-3 rounded-full border border-op-border text-sm disabled:opacity-50"
          >
            {busy === "check" ? t("checking") : t("checkStatus")}
          </button>
          {!chargeLocked && (
            <button
              type="button"
              onClick={() => act("cancel")}
              disabled={disabled || busy !== null}
              className="min-h-10 px-3 rounded-full border border-op-border text-sm disabled:opacity-50"
            >
              {busy === "cancel" ? t("cancelling") : t("cancelCharge")}
            </button>
          )}
        </div>
      )}
      {uncertain &&
        (reconcileHref ? (
          <Link
            href={reconcileHref}
            className="flex w-full min-h-11 items-center justify-center rounded-full bg-terracotta text-bone text-sm font-medium"
          >
            {tPending("reconcile")}
          </Link>
        ) : (
          <div className="rounded-lg border border-op-border bg-op-bg px-3 py-2 text-[11px] text-op-muted text-center">
            {tPending("reconcileAskAdmin")}
          </div>
        ))}
      {note && (
        <div className="text-xs text-op-muted" role="status">
          {note}
        </div>
      )}
      {showQr && tenantSlug && (
        <BreBSheet
          source={{ kind: "payment", tenantSlug, paymentId: pending.id }}
          operatorMode
          onApproved={(view) => {
            setShowQr(false);
            onApproved(view.orderPaid);
          }}
          onClosed={() => {
            setShowQr(false);
            onChanged();
          }}
        />
      )}
    </div>
  );
}
