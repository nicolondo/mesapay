"use client";

import { useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatMoney } from "@/lib/format";
import { useApiError } from "@/lib/useApiError";
import { usePaymentMethodLabel } from "@/lib/usePaymentMethodLabel";
import { isCashMethod } from "@/lib/payments/methods";
import { CashSettleModal } from "./CashSettleModal";
import type { TerminalAttemptView } from "@/lib/payments/terminalAttempt";
import type { BreBPendingView } from "@/lib/payments/breB/view";
import { TerminalAttemptActions, useTerminalAttemptState } from "./TerminalAttemptActions";
import { BreBPendingCard } from "./BreBPendingCard";

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
  /**
   * Datáfono Kushki ya enviado: qué se sabe del intento (en curso, el equipo
   * contestó que no, sin respuesta). Lo calcula el servidor
   * (`toTerminalAttemptView`, lib/payments/terminalAttempt.ts).
   */
  terminalAttempt?: TerminalAttemptView | null;
  /**
   * Bre-B: en qué va el QR (vigente con su vencimiento, o sin confirmar). Lo
   * calcula el servidor (`breBPendingViews`, lib/payments/breB/service.ts).
   */
  breB?: BreBPendingView | null;
};

/**
 * Detalle de la orden, abierto en el bloque «Conciliar pago» de ESE pago
 * (`?conciliar=` lo despliega, el ancla lo deja a la vista). Ver
 * src/app/operator/orders/[id]/page.tsx.
 */
export function reconcilePaymentHref(orderId: string, paymentId: string): string {
  return `/operator/orders/${orderId}?conciliar=${encodeURIComponent(paymentId)}#conciliar-${paymentId}`;
}

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
 *     el servidor exige. El datáfono Kushki tiene sus propias acciones según
 *     lo que contestó el equipo (TerminalAttemptActions): en curso,
 *     «Cancelar en el datáfono»; el equipo no lo aprobó, «Reintentar en el
 *     datáfono» / «Cancelar y cobrar de otra forma» al instante; sin
 *     respuesta, el administrador puede resolver de inmediato (`canResolveTerminal`,
 *     nunca el mesero) tiene "Resolver cobro", con evidencia.
 *   · Pago EN LÍNEA sin confirmar (tarjeta, Apple Pay o PSE marcado
 *     `reconciliationRequired`: el proveedor no contestó, o contestó y
 *     MESAPAY no se enteró): la cuenta sigue bloqueada hasta que alguien lo
 *     concilie. El administrador ve «Conciliar pago», que abre el bloque de
 *     conciliación en el detalle de la orden; los demás, que se lo pidan.
 *   · Bre-B en curso (BreBPendingCard): hay un QR vivo que alguien puede
 *     estar pagando. «Ver código» lo vuelve a mostrar, «Consultar estado»
 *     trae el resultado real de Kushki y «Cancelar cobro» invalida el QR;
 *     la cuenta se libera sólo cuando Kushki lo confirma. Si quedó sin
 *     confirmar, el administrador además ve «Conciliar pago».
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
  tenantSlug = null,
  terminalDeviceId = null,
  orderId = null,
}: {
  pendings: PendingPaymentView[];
  order: { shortCode: string; tableNumber: number };
  /** Id de la orden, para el enlace «Conciliar pago» a su detalle. */
  orderId?: string | null;
  serviceMode?: "table" | "counter";
  chargeLocked?: boolean;
  onConfirmed: (result: { paid: boolean }) => void;
  onDeclined?: () => void;
  /** Tras "Cancelar solicitud". Si falta, cae a `onDeclined` / `onRefresh`. */
  onCancelled?: () => void;
  onRefresh?: () => void;
  /**
   * Quien mira es administrador (operador, administrador de grupo o de
   * plataforma): puede "Resolver cobro" del datáfono sin respuesta y
   * «Conciliar pago» de un pago en línea sin confirmar. Mismos roles que
   * exige /api/operator/payments/[id]/reconcile.
   */
  canResolveTerminal?: boolean;
  disabled?: boolean;
  currency?: string;
  /** Para «Reintentar en el datáfono» (vuelve a mandar por `terminal/charge`). */
  tenantSlug?: string | null;
  /** Datáfono elegido en esta pantalla, si el servidor no sabe a cuál fue. */
  terminalDeviceId?: string | null;
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

      {inFlight.map((p) =>
        p.method === "kushki_card_terminal" ? (
          // Datáfono Kushki YA enviado al equipo: no se reemplaza ni se
          // cancela como una solicitud. Lo que se puede hacer depende de lo
          // que contestó el equipo (ver TerminalAttemptActions).
          <InFlightTerminalCard
            key={p.id}
            pending={p}
            money={money}
            methodLabel={methodLabel(p.method)}
            currency={currency}
            tenantSlug={tenantSlug}
            terminalDeviceId={terminalDeviceId}
            canResolve={canResolveTerminal}
            chargeLocked={chargeLocked}
            disabled={disabled || busyId !== null}
            onChanged={() => (onCancelled ?? onRefresh)?.()}
            onRefresh={onRefresh}
          />
        ) : p.method === "kushki_bre_b" ? (
          <BreBPendingCard
            key={p.id}
            pending={p}
            amountLabel={money(p.amountCents)}
            methodLabel={methodLabel(p.method)}
            tenantSlug={tenantSlug}
            chargeLocked={chargeLocked}
            disabled={disabled || busyId !== null}
            onApproved={(paid) => onConfirmed({ paid })}
            onChanged={() => (onCancelled ?? onRefresh)?.()}
            // Sin confirmar: además de «Consultar estado», el administrador
            // puede conciliarlo en el detalle de la orden (como tarjeta/PSE).
            reconcileHref={canResolveTerminal && orderId ? reconcilePaymentHref(orderId, p.id) : null}
          />
        ) : p.reconciliationRequired ? (
          // Pago en línea SIN CONFIRMAR: nadie va a contestar solo. Esperar no
          // lo destraba; se concilia (ver ReconcilePayment en el detalle de
          // la orden), y sólo el administrador puede.
          <div key={p.id} className="rounded-xl border-2 border-terracotta/60 bg-terracotta/10 p-3 space-y-2">
            <div className="font-mono text-[10px] tracking-wider uppercase text-terracotta">
              {t("inFlightReviewKicker")}
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-medium">{methodLabel(p.method)}</span>
              <span className="font-display text-xl tabular leading-none">{money(p.amountCents)}</span>
            </div>
            <p className="text-[11px] text-op-muted leading-snug">{t("inFlightReviewBody")}</p>
            {canResolveTerminal && orderId ? (
              <Link
                href={reconcilePaymentHref(orderId, p.id)}
                className="flex w-full min-h-11 items-center justify-center rounded-full bg-terracotta text-bone text-sm font-medium"
              >
                {t("reconcile")}
              </Link>
            ) : (
              <div className="rounded-lg border border-op-border bg-op-bg px-3 py-2 text-[11px] text-op-muted text-center">
                {t("reconcileAskAdmin")}
              </div>
            )}
            {onRefresh && (
              <div className="pt-1">
                <button type="button" onClick={onRefresh} disabled={disabled || busyId !== null}
                  className="min-h-10 px-3 rounded-full border border-op-border text-sm disabled:opacity-50">{t("refresh")}</button>
              </div>
            )}
          </div>
        ) : (
          <div key={p.id} className="rounded-xl border border-op-border bg-op-bg p-3 space-y-1">
            <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
              {t("inFlightKicker")}
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-medium">{methodLabel(p.method)}</span>
              <span className="font-display text-xl tabular leading-none">{money(p.amountCents)}</span>
            </div>
            <p className="text-[11px] text-op-muted leading-snug">{t("inFlightBody")}</p>
            {onRefresh && (
              <div className="pt-1">
                <button type="button" onClick={onRefresh} disabled={disabled || busyId !== null}
                  className="min-h-10 px-3 rounded-full border border-op-border text-sm disabled:opacity-50">{t("refresh")}</button>
              </div>
            )}
          </div>
        ),
      )}

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

/**
 * "Cobro enviado al datáfono Kushki": el título dice lo que se sabe del
 * intento (en curso / el datáfono no lo aprobó / no respondió) y debajo van
 * sus acciones.
 */
function InFlightTerminalCard({
  pending,
  money,
  methodLabel,
  currency,
  tenantSlug,
  terminalDeviceId,
  canResolve,
  chargeLocked,
  disabled,
  onChanged,
  onRefresh,
}: {
  pending: PendingPaymentView;
  money: (cents: number) => string;
  methodLabel: string;
  currency: string;
  tenantSlug: string | null;
  terminalDeviceId: string | null;
  canResolve: boolean;
  chargeLocked: boolean;
  disabled: boolean;
  onChanged: () => void;
  onRefresh?: () => void;
}) {
  const t = useTranslations("pendingPayment");
  const state = useTerminalAttemptState(pending.terminalAttempt);
  const attention = state === "answered" || state === "no_answer";
  return (
    <div
      className={`rounded-xl p-3 space-y-2 ${
        attention ? "border-2 border-terracotta/60 bg-terracotta/10" : "border border-op-border bg-op-bg"
      }`}
    >
      <div
        className={`font-mono text-[10px] tracking-wider uppercase ${attention ? "text-terracotta" : "text-op-muted"}`}
      >
        {state === "answered"
          ? t("terminalAnsweredKicker")
          : state === "no_answer"
            ? t("terminalNoAnswerKicker")
            : t("inFlightTerminalKicker")}
      </div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium">{methodLabel}</span>
        <span className="font-display text-xl tabular leading-none">{money(pending.amountCents)}</span>
      </div>
      {/* Sin datos del intento (dato viejo): el texto de siempre. Con datos,
          lo pone TerminalAttemptActions según el estado. */}
      {!pending.terminalAttempt && (
        <p className="text-[11px] text-op-muted leading-snug">{t("inFlightTerminalBody")}</p>
      )}
      <TerminalAttemptActions
        paymentId={pending.id}
        amountCents={pending.amountCents}
        currency={currency}
        attempt={pending.terminalAttempt}
        pushedAt={pending.pushedAt}
        tenantSlug={tenantSlug}
        fallbackDeviceId={terminalDeviceId}
        canResolve={canResolve}
        chargeLocked={chargeLocked}
        disabled={disabled}
        onChanged={onChanged}
      />
      {onRefresh && (
        <div className="pt-1">
          <button
            type="button"
            onClick={onRefresh}
            disabled={disabled}
            className="min-h-10 px-3 rounded-full border border-op-border text-sm disabled:opacity-50"
          >
            {t("refresh")}
          </button>
        </div>
      )}
    </div>
  );
}
