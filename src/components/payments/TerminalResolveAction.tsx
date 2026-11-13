"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatMoney } from "@/lib/format";
import { useApiError } from "@/lib/useApiError";
import {
  TERMINAL_RESOLVE_AUTH_MAX,
  TERMINAL_RESOLVE_AUTH_MIN,
  TERMINAL_RESOLVE_EVIDENCE_MAX,
  TERMINAL_RESOLVE_EVIDENCE_MIN,
  terminalResolvableAt,
} from "@/lib/payments/terminalResolve";

/**
 * Resolución manual inmediata de un cobro enviado: sólo el administrador,
 * tras verificar el datáfono, con evidencia y confirmación explícitas.
 * No espera una consulta remota ni un temporizador. El servidor valida de
 * nuevo rol, comercio, envío y estado bajo bloqueo de la cuenta.
 */
export function TerminalResolveAction({
  paymentId,
  pushedAt,
  amountCents,
  currency = "COP",
  canResolve,
  disabled = false,
  onResolved,
  initialOutcome,
}: {
  paymentId: string;
  /** Cuándo se envió al datáfono (ISO); null = no se sabe, no se ofrece. */
  pushedAt: string | null | undefined;
  amountCents: number;
  currency?: string;
  /** Rol administrador (nunca el mesero): ver `canResolveTerminalCharge`. */
  canResolve: boolean;
  disabled?: boolean;
  onResolved: () => void;
  /** La cancelación directa abre el mismo diálogo con "no se cobró" elegido. */
  initialOutcome?: "declined";
}) {
  const t = useTranslations("terminalResolve");
  const resolvableAt = terminalResolvableAt(pushedAt);
  const [open, setOpen] = useState(false);
  if (resolvableAt == null) return null;
  if (!canResolve) return <p className="text-[11px] text-op-muted leading-snug">{t("askAdmin")}</p>;
  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className="min-h-10 px-3 rounded-full bg-terracotta text-bone text-sm font-medium disabled:opacity-60"
      >
        {t(initialOutcome === "declined" ? "cancelManually" : "open")}
      </button>
      {open && (
        <ResolveTerminalChargeDialog
          paymentId={paymentId}
          amountCents={amountCents}
          currency={currency}
          initialOutcome={initialOutcome}
          onClose={() => setOpen(false)}
          onDone={() => {
            setOpen(false);
            onResolved();
          }}
        />
      )}
    </>
  );
}

function ResolveTerminalChargeDialog({
  paymentId,
  amountCents,
  currency,
  onClose,
  onDone,
  initialOutcome,
}: {
  paymentId: string;
  amountCents: number;
  currency: string;
  onClose: () => void;
  onDone: () => void;
  initialOutcome?: "declined";
}) {
  const t = useTranslations("terminalResolve");
  const locale = useLocale() as Locale;
  const apiError = useApiError();
  const [outcome, setOutcome] = useState<"declined" | "approved" | null>(initialOutcome ?? null);
  const [authorizationCode, setAuthorizationCode] = useState("");
  const [evidence, setEvidence] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready =
    outcome !== null &&
    confirmed &&
    evidence.trim().length >= TERMINAL_RESOLVE_EVIDENCE_MIN &&
    (outcome === "declined" || authorizationCode.trim().length >= TERMINAL_RESOLVE_AUTH_MIN);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/operator/payments/${paymentId}/resolve-terminal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          outcome,
          evidence: evidence.trim(),
          confirmed: true,
          ...(outcome === "approved" ? { authorizationCode: authorizationCode.trim() } : {}),
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(apiError(j, t("error")));
        return;
      }
      onDone();
    } catch {
      setError(t("error"));
    } finally {
      setBusy(false);
    }
  }

  const option = (value: "declined" | "approved", label: string) => (
    <label
      className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-sm cursor-pointer ${
        outcome === value ? "border-terracotta bg-terracotta/10" : "border-op-border"
      }`}
    >
      <input
        type="radio"
        name={`resolve-${paymentId}`}
        value={value}
        checked={outcome === value}
        onChange={() => setOutcome(value)}
      />
      {label}
    </label>
  );

  return (
    <div
      // Sin cierre al tocar afuera: es un formulario, y un clic perdido borraba lo digitado.
      className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={`resolve-title-${paymentId}`}
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="w-full md:max-w-md max-h-[90vh] overflow-y-auto bg-op-surface rounded-t-3xl md:rounded-3xl border border-op-border p-5 space-y-4"
      >
        <div>
          <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
            {t("amount", { amount: formatMoney(amountCents, { locale, currency }) })}
          </div>
          <h2 id={`resolve-title-${paymentId}`} className="font-display text-2xl">
            {t("title")}
          </h2>
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium">{t("question")}</p>
          <p className="text-[12px] text-op-muted leading-snug">{t("checkHint")}</p>
        </div>
        <div className="grid gap-2">
          {option("declined", t("declinedOption"))}
          {option("approved", t("approvedOption"))}
        </div>
        {outcome === "approved" && (
          <label className="grid gap-1 text-sm">
            {t("authorization")}
            <input
              className="mp-input w-full"
              required
              minLength={TERMINAL_RESOLVE_AUTH_MIN}
              maxLength={TERMINAL_RESOLVE_AUTH_MAX}
              value={authorizationCode}
              onChange={(e) => setAuthorizationCode(e.target.value)}
              autoComplete="off"
            />
          </label>
        )}
        <label className="grid gap-1 text-sm">
          {t("evidence")}
          <textarea
            className="mp-input w-full"
            required
            minLength={TERMINAL_RESOLVE_EVIDENCE_MIN}
            maxLength={TERMINAL_RESOLVE_EVIDENCE_MAX}
            placeholder={t("evidencePlaceholder")}
            value={evidence}
            onChange={(e) => setEvidence(e.target.value)}
          />
          <span className="text-[11px] text-op-muted">
            {t("evidenceHint", { min: TERMINAL_RESOLVE_EVIDENCE_MIN })}
          </span>
        </label>
        <label className="flex gap-2 text-sm">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          {t("confirm")}
        </label>
        {error && (
          <p role="alert" className="text-danger text-sm">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 min-h-11 rounded-full border border-op-border text-sm"
          >
            {t("back")}
          </button>
          <button
            type="submit"
            disabled={!ready || busy}
            className="flex-1 min-h-11 rounded-full bg-terracotta text-bone text-sm font-medium disabled:opacity-60"
          >
            {busy
              ? t("saving")
              : outcome === "approved"
                ? t("submitApproved")
                : t("submitDeclined")}
          </button>
        </div>
      </form>
    </div>
  );
}
