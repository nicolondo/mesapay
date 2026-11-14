"use client";

import { useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatMoney } from "@/lib/format";
import { useApiError } from "@/lib/useApiError";
import {
  terminalAttemptState,
  type TerminalAttemptState,
  type TerminalAttemptView,
} from "@/lib/payments/terminalAttempt";
import { TerminalResolveAction } from "./TerminalResolveAction";
import { terminalAmountText, terminalChargeResponseText } from "./TerminalAmountNote";

/**
 * En qué estado está AHORA un intento enviado al datáfono. Lo que sale de
 * los datos (contestó / quedó incierto) se decide igual en el servidor y en
 * el navegador; el paso de "en curso" a "sin respuesta" depende de la hora y
 * sólo se calcula ya montado (así la hidratación no se desarma).
 */
export function useTerminalAttemptState(
  attempt: TerminalAttemptView | null | undefined,
): TerminalAttemptState | null {
  const [now, setNow] = useState<number | null>(null);
  const timeBased = !!attempt && !attempt.answeredAt && !attempt.uncertain;
  const pushedAt = attempt?.pushedAt;
  useEffect(() => {
    if (!timeBased) return;
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 5000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [timeBased, pushedAt]);
  if (!attempt) return null;
  if (attempt.answeredAt) return "answered";
  if (attempt.uncertain) return "no_answer";
  return now == null ? "in_flight" : terminalAttemptState(attempt, now);
}

type Busy = "abort" | "retry" | "cancel" | "check" | null;

/**
 * Lo que se ve de un cobro del datáfono Kushki YA enviado y sin aprobar,
 * en la tarjeta "Cobro enviado al datáfono" (ficha de la mesa, cobro del
 * staff, Salón y la pantalla de espera del staff):
 *
 *   - en curso: «Cancelar en el datáfono» (le pide al equipo que cancele; la
 *     cuenta se libera sola cuando el equipo responde). El administrador
 *     también puede cancelar manualmente, con evidencia, sin esperar;
 *   - el equipo contestó que no: «Reintentar en el datáfono» y «Cancelar y
 *     cobrar de otra forma», al instante y para cualquiera que cobre la mesa,
 *     confirmando en la pantalla del datáfono que el cobro no salió;
 *   - sin respuesta: puede haber cobrado. Revisar el datáfono y el voucher, y
 *     "Resolver cobro" (administrador, sin espera, con evidencia).
 *
 * El servidor vuelve a exigir todo (estado del intento bajo `lockOrder`,
 * roles, control de caja). Ver /api/operator/payments/[id]/terminal-attempt.
 */
export function TerminalAttemptActions({
  paymentId,
  amountCents,
  currency = "COP",
  attempt,
  pushedAt,
  tenantSlug,
  fallbackDeviceId = null,
  canResolve,
  chargeLocked = false,
  disabled = false,
  onChanged,
  onOutcome,
}: {
  paymentId: string;
  amountCents: number;
  currency?: string;
  /** Qué se sabe del intento; null/undefined = dato viejo, sólo "Resolver cobro". */
  attempt: TerminalAttemptView | null | undefined;
  /** Cuándo se envió (ISO), para verificar que el cobro salió al equipo. */
  pushedAt: string | null | undefined;
  /** Para volver a mandar el cobro por `terminal/charge`. */
  tenantSlug?: string | null;
  /** Datáfono elegido en esta pantalla, si el servidor no sabe a cuál fue. */
  fallbackDeviceId?: string | null;
  /** Administrador: "Resolver cobro" cuando el equipo no respondió. */
  canResolve: boolean;
  /** "Solo el administrador cobra" y quien mira es un mesero. */
  chargeLocked?: boolean;
  /** Bloquea acciones normales mientras se envía; no la resolución manual administrativa. */
  disabled?: boolean;
  /** Después de cualquier acción: refrescar la cuenta. */
  onChanged: () => void;
  /**
   * Resultado del reintento que conviene mostrar aunque esta tarjeta ya no
   * exista (el pago viejo se declina y la tarjeta desaparece). Sin él, se
   * muestra acá si sigue montada.
   */
  onOutcome?: (message: string) => void;
}) {
  const t = useTranslations("terminalAttempt");
  const locale = useLocale() as Locale;
  const apiError = useApiError();
  const state = useTerminalAttemptState(attempt);
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const resolve = (
    <TerminalResolveAction
      paymentId={paymentId}
      pushedAt={attempt?.pushedAt ?? pushedAt}
      amountCents={amountCents}
      currency={currency}
      canResolve={canResolve}
      // El envío/consulta remotos pueden seguir esperando. La resolución
      // manual existe para destrabarlos y valida el estado bajo lockOrder.
      disabled={busy === "retry" || busy === "cancel"}
      initialOutcome={state === "in_flight" ? "declined" : undefined}
      onResolved={onChanged}
    />
  );
  // Sin datos del intento (pantalla vieja o dato incompleto): como antes.
  if (!attempt || !state) return resolve;

  const moneyOf = (cents: number) => formatMoney(cents, { locale, currency, fractionDigits: cents % 100 ? 2 : 0 });
  const money = moneyOf(amountCents);
  const blocked = disabled || busy !== null;

  /** Un resultado que puede llegar con la tarjeta ya desmontada. */
  function report(message: string, kind: "notice" | "error") {
    if (onOutcome) onOutcome(message);
    else if (mounted.current) (kind === "error" ? setErr : setNotice)(message);
  }

  async function attemptAction(action: "cancel" | "retry", confirmed: boolean) {
    const res = await fetch(`/api/operator/payments/${paymentId}/terminal-attempt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(confirmed ? { action, confirmed: true } : { action }),
    });
    return { ok: res.ok, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  async function abort() {
    if (blocked) return;
    setBusy("abort");
    setErr(null);
    setNotice(null);
    try {
      const { ok, json } = await attemptAction("cancel", false);
      if (!ok) {
        setErr(apiError(json, t("error")));
        onChanged();
        return;
      }
      setNotice(
        json.abort === "aborted" || json.abort === "mock"
          ? t("abortSent")
          : json.abort === "not_active"
            ? t("abortNotActive")
            : t("abortFailed"),
      );
    } catch {
      setErr(t("error"));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  /**
   * «Consultar en Kushki»: busca el resultado real del cobro. Aprobado o
   * rechazado → la cuenta se actualiza (y esta tarjeta desaparece); sin
   * resultado → lo dice, y sigue "Resolver cobro".
   */
  async function check() {
    if (blocked) return;
    setBusy("check");
    setErr(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/operator/payments/${paymentId}/terminal-attempt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "check" }),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        setErr(apiError(json, t("checkError")));
        return;
      }
      if (json.status === "approved") report(t("checkApproved"), "notice");
      else if (json.status === "declined") report(t("checkDeclined"), "notice");
      else if (json.result === "not_found") report(t("checkNotFound"), "notice");
      else if (json.result === "unknown:amount_mismatch") report(t("checkAmountMismatch"), "notice");
      else if (typeof json.result === "string" && json.result.startsWith("unknown")) report(t("checkUnknown"), "notice");
      else report(t("checkError"), "error");
      if (json.status === "approved" || json.status === "declined") onChanged();
    } catch {
      setErr(t("checkError"));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  async function close(action: "cancel" | "retry") {
    if (blocked) return;
    const question = action === "retry" ? t("confirmRetry", { amount: money }) : t("confirmCancel");
    if (!window.confirm(question)) return;
    setBusy(action);
    setErr(null);
    setNotice(null);
    try {
      const { ok, json } = await attemptAction(action, true);
      if (!ok) {
        setErr(apiError(json, t("error")));
        onChanged();
        return;
      }
      if (action === "cancel") {
        onChanged();
        return;
      }
      // Reintento: el intento viejo ya quedó cerrado y hay un pago nuevo
      // pendiente. Se empuja al mismo datáfono por el camino de siempre.
      const nextId = typeof json.paymentId === "string" ? json.paymentId : null;
      const deviceId = (typeof json.deviceId === "string" && json.deviceId) || fallbackDeviceId;
      if (!nextId || !deviceId || !tenantSlug) {
        report(t("retryNoDevice"), "notice");
        onChanged();
        return;
      }
      const push = await fetch(`/api/tenant/${tenantSlug}/terminal/charge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paymentId: nextId, deviceId }),
      });
      const pj = (await push.json().catch(() => ({}))) as Record<string, unknown>;
      // El datáfono aprobó otro monto: se dice qué pasó con la diferencia.
      const amountOutcome = terminalChargeResponseText(pj, t, moneyOf);
      if (!push.ok) report(apiError(pj, t("retryFailed")), "error");
      else if (amountOutcome) report(amountOutcome, "notice");
      else if (pj.status === "approved") report(t("retryApproved"), "notice");
      onChanged();
    } catch {
      report(t("error"), "error");
      onChanged();
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  const feedback = (
    <>
      {notice && (
        <p role="status" className="text-[11px] text-op-muted leading-snug">
          {notice}
        </p>
      )}
      {err && (
        <p role="alert" className="text-[11px] text-danger leading-snug">
          {err}
        </p>
      )}
    </>
  );

  if (state === "in_flight") {
    return (
      <div className="space-y-2">
        <p className="text-[11px] text-op-muted leading-snug">{t("inFlightBody")}</p>
        {!chargeLocked && (
          <button
            type="button"
            onClick={abort}
            disabled={blocked}
            className="w-full min-h-10 rounded-full border border-op-border bg-op-surface text-sm disabled:opacity-60"
          >
            {busy === "abort" ? t("aborting") : t("abort")}
          </button>
        )}
        {feedback}
        {resolve}
      </div>
    );
  }

  if (state === "answered") {
    const detail = [attempt.answerCode, attempt.answerMessage?.slice(0, 120)].filter(Boolean).join(" · ");
    return (
      <div className="space-y-2">
        <p className="text-[12px] leading-snug">
          {detail ? t("answeredBody", { detail }) : t("answeredBodyGeneric")}
        </p>
        {chargeLocked ? (
          <div className="rounded-lg border border-op-border bg-op-bg px-3 py-2 text-[11px] text-op-muted text-center">
            {t("adminOnly")}
          </div>
        ) : (
          <>
            <p className="text-[11px] text-op-muted leading-snug">{t("checkDevice")}</p>
            <div className="grid gap-2">
              <button
                type="button"
                onClick={() => close("retry")}
                disabled={blocked}
                className="w-full min-h-11 rounded-full bg-terracotta text-bone text-sm font-medium disabled:opacity-60"
              >
                {busy === "retry" ? t("retrying") : t("retry")}
              </button>
              <button
                type="button"
                onClick={() => close("cancel")}
                disabled={blocked}
                className="w-full min-h-11 rounded-full border border-op-border bg-op-surface text-sm disabled:opacity-60"
              >
                {busy === "cancel" ? t("cancelling") : t("cancel")}
              </button>
            </div>
          </>
        )}
        {feedback}
      </div>
    );
  }

  // Consulta remota y resolución manual son alternativas. La consulta no bloquea el diálogo.
  // Kushki SÍ aprobó, por otro monto: no es "sin respuesta", es «monto cobrado
  // distinto» (con los dos montos); se resuelve igual, con el comprobante.
  return (
    <div className="space-y-2">
      <p className="text-[12px] leading-snug">
        {attempt.amountMismatch ? terminalAmountText(attempt.amountMismatch, "full", t, moneyOf) : t("noAnswerBody")}
      </p>
      <button
        type="button"
        onClick={check}
        disabled={blocked}
        className="w-full min-h-10 rounded-full border border-op-border bg-op-surface text-sm disabled:opacity-60"
      >
        {busy === "check" ? t("checking") : t("check")}
      </button>
      {feedback}
      {resolve}
    </div>
  );
}
