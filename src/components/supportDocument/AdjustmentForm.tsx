"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { MoneyInput } from "@/components/MoneyInput";
import { formatMoney } from "@/lib/format";
import { inputCls, labelCls, type ApiError, type SupportDocView } from "./shared";

const REASONS = ["2", "1", "3", "4", "5"] as const;
const MIN_DESCRIPTION = 20;

/**
 * Nota de ajuste a un documento soporte aceptado (CreditNote tipo 95). La
 * anulación (concepto 2) ajusta todo lo que queda; los demás conceptos, el
 * valor base que se indique (el IVA se ajusta en proporción).
 */
export function AdjustmentForm({
  doc,
  currency,
  onDone,
  onCancel,
}: {
  doc: SupportDocView;
  currency: string;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const t = useTranslations("opSupportDoc");
  const locale = useLocale() as Locale;
  const [reason, setReason] = useState<(typeof REASONS)[number]>("2");
  const [text, setText] = useState("");
  // Pesos sin agrupar ("250000.50"), como los entrega MoneyInput.
  const [amountRaw, setAmountRaw] = useState("");
  const amount = amountRaw.trim() ? Math.round(Number(amountRaw) * 100) : null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isVoid = reason === "2";
  const money = (c: number) => formatMoney(c, { currency, locale });
  const valid =
    text.trim().length >= MIN_DESCRIPTION &&
    (isVoid || (amount != null && Number.isFinite(amount) && amount > 0 && amount <= doc.adjustableCents));

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/operator/support-documents/${doc.id}/adjustments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reasonCode: reason, reasonText: text.trim(), amountCents: isVoid ? null : amount }),
      });
      const data = (await res.json().catch(() => ({}))) as ApiError & {
        document?: { documentNumber: string; state: string };
      };
      if (!res.ok || !data.document) {
        setError(t.has(`errors.${data.error}`) ? t(`errors.${data.error}`) : t("errors.generic"));
        return;
      }
      onDone(t("sentResult", { number: data.document.documentNumber, state: t(`state.${data.document.state}`) }));
    } catch {
      setError(t("errors.network"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 rounded-xl border border-op-border bg-op-bg p-4 space-y-3">
      <div className="text-sm font-medium">{t("adjustTitle", { number: doc.documentNumber })}</div>
      <div>
        <label className={labelCls} htmlFor={`ds-reason-${doc.id}`}>{t("reasonLabel")}</label>
        <select
          id={`ds-reason-${doc.id}`}
          className={inputCls}
          value={reason}
          onChange={(e) => setReason(e.target.value as (typeof REASONS)[number])}
        >
          {REASONS.map((r) => (
            <option key={r} value={r}>
              {t(`reason.${r}`)}
            </option>
          ))}
        </select>
        {isVoid && <p className="text-[11px] text-op-muted mt-1">{t("voidHint")}</p>}
      </div>
      {!isVoid && (
        <div>
          <span className={labelCls}>{t("amountLabel")}</span>
          <MoneyInput value={amountRaw} onChange={setAmountRaw} fractionDigits={2} className={inputCls} />
          <p className="text-[11px] text-op-muted mt-1">{t("amountHint", { max: money(doc.adjustableCents) })}</p>
        </div>
      )}
      <div>
        <label className={labelCls} htmlFor={`ds-text-${doc.id}`}>{t("descriptionLabel")}</label>
        <textarea
          id={`ds-text-${doc.id}`}
          rows={2}
          maxLength={5000}
          className="w-full px-3 py-2 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-op-text/40"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <p className="text-[11px] text-op-muted mt-1">
          {t("descriptionHint", { count: Math.max(0, MIN_DESCRIPTION - text.trim().length) })}
        </p>
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className="mp-btn mp-btn--ghost mp-btn--sm" onClick={onCancel} disabled={busy}>
          {t("cancel")}
        </button>
        <button type="button" className="mp-btn mp-btn--primary mp-btn--sm" onClick={submit} disabled={busy || !valid}>
          {busy ? t("sending") : t("submitAdjust")}
        </button>
      </div>
    </div>
  );
}
