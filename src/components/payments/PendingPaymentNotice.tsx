"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatMoney } from "@/lib/format";
import { useApiError } from "@/lib/useApiError";
import { usePaymentMethodLabel } from "@/lib/usePaymentMethodLabel";
import { isCashMethod } from "@/lib/payments/methods";
import { CashSettleModal } from "./CashSettleModal";
import { TerminalResolveAction } from "./TerminalResolveAction";

/** Un pago `pending` de la cuenta, como lo necesita el aviso. */
export type PendingPaymentView = {
  id: string;
  method: string;
  /** TOTAL (comida + propina), como `Payment.amountCents`. */
  amountCents: number;
  tipCents: number;
  cashTenderCents: number | null;
  createdAt: string;
  /**
   * Solicitud sin plata en vuelo (efectivo, datáfono propio, datáfono Kushki
   * que nadie envió al equipo): se cancela, o el cobro del staff la
   * reemplaza. `false` = puede haber un cobro en curso en el proveedor. Lo
   * calcula el servidor (`withReplaceable`, lib/payments/pendingRequests.ts).
   */
  replaceable: boolean;
  /** Marcado para conciliación (sin respuesta del proveedor). */
  reconciliationRequired?: boolean;
  /**
   * Datáfono Kushki: cuándo se envió al equipo (ISO), para la cuenta
   * regresiva de "Resolver cobro". null = nunca se envió.
   */
  pushedAt?: string | null;
};

/**
 * Aviso de pagos pendientes de una cuenta, arriba de la ficha de la mesa y
 * de la pantalla de cobro del staff.
 *
 *   · SOLICITUD ("pidió pagar con datáfono del comercio / efectivo por $X",
 *     o el datáfono Kushki pedido que nadie envió al equipo): efectivo y
 *     datáfono propio tienen "Confirmar pago recibido", que aprueba ESE
 *     pendiente por la misma ruta que Salón (`settle-external-terminal` /
 *     `settle-cash`); todas tienen "Cancelar solicitud"
 *     (`cancel-request`). Si en cambio se cobra de otra forma, el servidor
 *     la reemplaza sola (ver staffCharge.ts).
 *   · Pago EN LÍNEA en curso (PSE, tarjeta, datáfono Kushki ya enviado): sin
 *     acción de cobro; dice que hay que esperar su resultado, que es lo que
 *     el servidor exige. Para el datáfono, pasados 3 minutos sin respuesta,
 *     el administrador (`canResolveTerminal`, nunca el mesero) tiene
 *     "Resolver cobro": rechazado o aprobado, con evidencia.
 *
 * `chargeLocked`: "solo el administrador cobra" y quien mira es un mesero —
 * ve la solicitud pero no la acción (el servidor la rebotaría igual).
 */
export function PendingPaymentNotice({
  pendings,
  order,
  serviceMode = "table",
  chargeLocked = false,
  onConfirmed,
  onDeclined,
  onCancelled,
  onRefresh,
  canResolveTerminal = false,
  disabled = false,
  currency = "COP",
}: {
  pendings: PendingPaymentView[];
  order: { shortCode: string; tableNumber: number };
  serviceMode?: "table" | "counter";
  chargeLocked?: boolean;
  onConfirmed: (result: { paid: boolean }) => void;
  onDeclined?: () => void;
  /** Tras "Cancelar solicitud". Si falta, cae a `onDeclined` / `onRefresh`. */
  onCancelled?: () => void;
  onRefresh?: () => void;
  /** Quien mira es administrador: puede "Resolver cobro" del datáfono sin respuesta. */
  canResolveTerminal?: boolean;
  disabled?: boolean;
  currency?: string;
}) {
  const t = useTranslations("pendingPayment");
  const methodLabel = usePaymentMethodLabel();
  const locale = useLocale() as Locale;
  const money = (cents: number) => formatMoney(cents, { locale, currency, fractionDigits: cents % 100 ? 2 : 0 });
  const apiError = useApiError();
  const [busy, setBusy] = useState<{ id: string; kind: "confirm" | "cancel" } | null>(null);
  const busyId = busy?.id ?? null;
  const [err, setErr] = useState<{ id: string; message: string } | null>(null);
  const [cashTarget, setCashTarget] = useState<PendingPaymentView | null>(null);

  if (pendings.length === 0) return null;
  const requests = pendings.filter((p) => p.replaceable);
  const inFlight = pendings.filter((p) => !p.replaceable);

  async function confirm(p: PendingPaymentView, action: "approve" | "decline" = "approve") {
    if (disabled || busyId !== null) return;
    if (action === "decline" && !window.confirm(t("declineConfirm"))) return;
    setErr(null);
    // Efectivo: recibido / devuelta / propina, igual que en Salón.
    if (isCashMethod(p.method)) {
      setCashTarget(p);
      return;
    }
    setBusy({ id: p.id, kind: "confirm" });
    try {
      const res = await fetch(`/api/operator/payments/${p.id}/settle-external-terminal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr({ id: p.id, message: apiError(j, t("confirmError")) });
        onRefresh?.();
        return;
      }
      if (action === "decline") onDeclined?.();
      else onConfirmed({ paid: j.paid === true });
    } catch {
      setErr({ id: p.id, message: t("confirmError") });
      onRefresh?.();
    } finally {
      setBusy(null);
    }
  }

  // "Cancelar solicitud": declina el pendiente sin cobrar nada. El servidor
  // rebota con pending_payment_in_flight si mientras tanto se envió al
  // datáfono (ver /api/operator/payments/[id]/cancel-request).
  async function cancelRequest(p: PendingPaymentView) {
    if (disabled || busyId !== null) return;
    if (!window.confirm(t("cancelRequestConfirm"))) return;
    setErr(null);
    setBusy({ id: p.id, kind: "cancel" });
    try {
      const res = await fetch(`/api/operator/payments/${p.id}/cancel-request`, { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr({ id: p.id, message: apiError(j, t("cancelRequestError")) });
        onRefresh?.();
        return;
      }
      (onCancelled ?? onDeclined ?? onRefresh)?.();
    } catch {
      setErr({ id: p.id, message: t("cancelRequestError") });
      onRefresh?.();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-2" aria-live="polite">
      {requests.map((p) => {
        // Datáfono Kushki pedido que nadie envió al equipo: no hay pago que
        // confirmar a mano, sólo cancelar o cobrar de otra forma.
        const terminalRequest = p.method === "kushki_card_terminal";
        const tender =
          isCashMethod(p.method) && p.cashTenderCents != null && p.cashTenderCents > p.amountCents
            ? p.cashTenderCents
            : null;
        // El datáfono propio ya tiene su "No se recibió este pago" (que
        // también lo declina): no repetimos la acción con otro nombre.
        const declineShown = !chargeLocked && !!onDeclined && p.method === "external_terminal";
        return (
          <div
            key={p.id}
            className="rounded-xl border-2 border-terracotta/60 bg-terracotta/10 p-3 space-y-2"
          >
            <div className="font-mono text-[10px] tracking-wider uppercase text-terracotta">
              {terminalRequest ? t("terminalRequestKicker") : t("requestKicker")}
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-medium">{methodLabel(p.method)}</span>
              <span className="font-display text-2xl tabular leading-none">
                {money(p.amountCents)}
              </span>
            </div>
            {p.tipCents > 0 && (
              <div className="text-[11px] text-op-muted text-right">
                {t("includesTip", { amount: money(p.tipCents) })}
              </div>
            )}
            {tender != null && (
              <div className="text-[11px] text-op-muted text-right">
                {t("cashTender", { amount: money(tender) })}
              </div>
            )}
            {terminalRequest && (
              <p className="text-[11px] text-op-muted leading-snug">{t("terminalRequestBody")}</p>
            )}
            {chargeLocked ? (
              <div className="rounded-lg border border-op-border bg-op-bg px-3 py-2 text-[11px] text-op-muted text-center">
                {t("adminOnly")}
              </div>
            ) : (
              !terminalRequest && (
                <button
                  type="button"
                  onClick={() => confirm(p)}
                  disabled={disabled || busyId !== null}
                  className="w-full h-11 rounded-full bg-ok text-bone text-sm font-medium disabled:opacity-60"
                >
                  {busy?.id === p.id && busy.kind === "confirm" ? t("confirming") : t("confirm")}
                </button>
              )
            )}
            {declineShown && (
              <button type="button" disabled={disabled || busyId !== null} onClick={() => confirm(p, "decline")}
                className="w-full min-h-10 rounded-full border border-op-border text-sm disabled:opacity-50">
                {t("decline")}
              </button>
            )}
            {!chargeLocked && !declineShown && (
              <button
                type="button"
                disabled={disabled || busyId !== null}
                onClick={() => cancelRequest(p)}
                className="w-full min-h-10 rounded-full border border-op-border text-sm disabled:opacity-50"
              >
                {busy?.id === p.id && busy.kind === "cancel" ? t("cancellingRequest") : t("cancelRequest")}
              </button>
            )}
            {err?.id === p.id && <div className="text-danger text-xs">{err.message}</div>}
            {!chargeLocked && !onDeclined && !terminalRequest && (
              <p className="text-[11px] text-op-muted leading-snug">{t("replaceHint")}</p>
            )}
          </div>
        );
      })}

      {inFlight.map((p) => {
        // Datáfono Kushki YA enviado al equipo: puede haber un cobro en
        // curso. No se cancela ni se reemplaza; si no responde, pasados 3
        // minutos el administrador lo resuelve ("Resolver cobro").
        const terminal = p.method === "kushki_card_terminal";
        return (
          <div key={p.id} className="rounded-xl border border-op-border bg-op-bg p-3 space-y-1">
            <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
              {terminal ? t("inFlightTerminalKicker") : t("inFlightKicker")}
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-medium">{methodLabel(p.method)}</span>
              <span className="font-display text-xl tabular leading-none">{money(p.amountCents)}</span>
            </div>
            <p className="text-[11px] text-op-muted leading-snug">
              {terminal ? t("inFlightTerminalBody") : t("inFlightBody")}
            </p>
            {terminal && (
              <TerminalResolveAction
                paymentId={p.id}
                pushedAt={p.pushedAt}
                amountCents={p.amountCents}
                currency={currency}
                canResolve={canResolveTerminal}
                disabled={disabled || busyId !== null}
                onResolved={() => (onCancelled ?? onRefresh)?.()}
              />
            )}
            {onRefresh && (
              <div className="pt-1">
                <button type="button" onClick={onRefresh} disabled={disabled || busyId !== null}
                  className="min-h-10 px-3 rounded-full border border-op-border text-sm disabled:opacity-50">{t("refresh")}</button>
              </div>
            )}
          </div>
        );
      })}

      {cashTarget && (
        <CashSettleModal
          pending={{
            id: cashTarget.id,
            amountCents: cashTarget.amountCents,
            cashTenderCents: cashTarget.cashTenderCents,
            order,
          }}
          serviceMode={serviceMode}
          onClose={() => setCashTarget(null)}
          onDone={(result) => {
            setCashTarget(null);
            onConfirmed(result);
          }}
        />
      )}
    </div>
  );
}
