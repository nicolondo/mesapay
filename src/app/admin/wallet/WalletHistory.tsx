"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { formatDate, formatMoney } from "@/lib/format";
import type { Locale } from "@/i18n/config";
import { errorCode, fieldClass, secondaryButton, walletRequest, type Payout } from "./client";

export function WalletHistory({ payouts, loading, error, hasMore, onLoadMore, onReload, onUpdate }: {
  payouts: Payout[]; loading: boolean; error: string; hasMore: boolean;
  onLoadMore: () => void; onReload: () => void; onUpdate: (payout: Payout) => void;
}) {
  const t = useTranslations("platformWallet");
  const locale = useLocale() as Locale;
  const [tickets, setTickets] = useState<Record<string, string>>({});
  const [checking, setChecking] = useState<string | null>(null);
  const [checkError, setCheckError] = useState<{ id: string; code: string } | null>(null);
  async function refresh(id: string) {
    if (checking) return;
    setChecking(id); setCheckError(null);
    try {
      const result = await walletRequest<{ payout: Payout }>(`payouts/${id}/refresh`, { method: "POST", body: JSON.stringify(tickets[id]?.trim() ? { ticketNumber: tickets[id].trim() } : {}) });
      onUpdate(result.payout);
    } catch (e) { setCheckError({ id, code: errorCode(e) }); }
    finally { setChecking(null); }
  }
  return (
    <section className="overflow-hidden rounded-2xl border border-op-border bg-op-surface" aria-labelledby="wallet-history-title">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-op-border p-5 md:px-6">
        <div><h2 id="wallet-history-title" className="font-display text-2xl">{t("historyTitle")}</h2><p className="mt-1 text-xs text-op-muted">{t("historyHint")}</p></div>
        <button type="button" className={secondaryButton} onClick={onReload} disabled={loading}>{t("refreshHistory")}</button>
      </div>
      {error && <p role="alert" className="m-5 rounded-xl bg-red-50 p-3 text-sm text-red-700">{t(t.has(`errors.${error}`) ? `errors.${error}` : "errors.request_failed")}</p>}
      {!payouts.length && <p className="p-6 text-sm text-op-muted" role="status">{t(loading ? "loading" : "emptyHistory")}</p>}
      <ul className="divide-y divide-op-border">
        {payouts.map((payout) => {
          const pending = ["submitting", "initialized", "unknown"].includes(payout.status);
          return <li key={payout.id} className="p-5 md:px-6" data-payout-id={payout.id}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0"><h3 className="break-words font-medium">{payout.holderName}</h3><p className="mt-1 text-sm text-op-muted">{payout.bankName} · {t(`account_${payout.accountType}`)} · {t("accountEnding", { last4: payout.accountLast4 })}</p></div>
              <div className="text-left sm:text-right"><p className="font-mono text-lg tabular-nums">{formatMoney(payout.amountCents, { currency: payout.currency, locale })}</p><span className={`mt-1 inline-flex rounded-full px-2.5 py-1 text-xs ${payout.status === "approved" ? "bg-emerald-50 text-emerald-800" : ["declined", "failed"].includes(payout.status) ? "bg-red-50 text-red-700" : "bg-op-bg text-op-muted"}`}>{t(`status_${payout.status}`)}</span></div>
            </div>
            {payout.description && <p className="mt-2 break-words text-sm">{payout.description}</p>}
            <p className="mt-3 text-xs text-op-muted">{formatDate(payout.createdAt, { locale, timeZone: "America/Bogota" })} · {payout.accountLabel} · {t(`mode_${payout.mode}`)}</p>
            <dl className="mt-2 space-y-1 text-xs text-op-muted"><div className="flex flex-wrap gap-x-2"><dt>{t("reference")}</dt><dd className="break-all font-mono">{payout.reference}</dd></div>{payout.ticketNumber && <div className="flex flex-wrap gap-x-2"><dt>{t("ticket")}</dt><dd className="break-all font-mono">{payout.ticketNumber}</dd></div>}</dl>
            {payout.status === "unknown" && <p className="mt-3 text-sm text-amber-800">{t("unknownHint")}</p>}
            {payout.errorCode && <p className="mt-2 text-sm text-op-muted">{t(t.has(`errors.${payout.errorCode}`) ? `errors.${payout.errorCode}` : "errors.payout_status_unavailable")}</p>}
            {pending && !payout.ticketNumber && <label className="mt-3 block max-w-sm text-sm">{t("recoverTicket")}<input aria-label={t("recoverTicket")} className={fieldClass} value={tickets[payout.id] ?? ""} onChange={(e) => setTickets((current) => ({ ...current, [payout.id]: e.target.value }))} inputMode="numeric" maxLength={128} autoComplete="off" /><span className="mt-1 block text-xs text-op-muted">{t("recoverTicketHint")}</span></label>}
            {pending && <button type="button" className={`${secondaryButton} mt-3`} disabled={checking !== null} onClick={() => refresh(payout.id)}>{t(checking === payout.id ? "checking" : "checkStatus")}</button>}
            {checkError?.id === payout.id && <p role="alert" className="mt-2 text-sm text-red-700">{t(t.has(`errors.${checkError.code}`) ? `errors.${checkError.code}` : "errors.request_failed")}</p>}
          </li>;
        })}
      </ul>
      {hasMore && <div className="border-t border-op-border p-5"><button type="button" className={secondaryButton} disabled={loading} onClick={onLoadMore}>{t(loading ? "loading" : "loadMore")}</button></div>}
    </section>
  );
}
