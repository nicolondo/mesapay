"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import type { Locale } from "@/i18n/config";
import { formatDate, formatMoney, formatNumber } from "@/lib/format";
import type { TrackingHistoryCandidate } from "@/lib/walletTracking/contracts";
import type { WalletTrackingController } from "./walletTracking/useWalletTracking";
import { trackingEstimateForDisplay } from "./walletTracking/client";
import { TrackingHistory } from "./walletTracking/TrackingHistory";
import { TrackingMutationDialog } from "./walletTracking/TrackingMutationDialog";

const button = "min-h-11 rounded-full border border-op-border px-4 py-2 text-sm font-medium hover:bg-op-bg disabled:opacity-50";
export function WalletTrackingSummary({ tracking, dark = false }: { tracking: WalletTrackingController; dark?: boolean }) {
  const t = useTranslations("walletTracking");
  const locale = useLocale() as Locale;
  const view = tracking.view;
  const amount = trackingEstimateForDisplay(view);
  const discrepancy = view?.signedDifferenceCents !== null && (view?.signedDifferenceCents ?? 0) < 0;
  const known = typeof amount === "number" && !!view?.currency && !discrepancy;
  const stale = Boolean(view && (tracking.error || view.status === "stale"));
  return <section aria-label={t("pendingTitle")} className={`min-w-0 rounded-xl border p-4 ${dark ? "border-bone/20 bg-bone/5 text-bone" : "border-op-border bg-op-bg text-op-text"}`}>
    <h3 className="text-sm opacity-80">{t("pendingTitle")}</h3>
    <p className="mt-2 text-[10px] font-medium uppercase tracking-wider opacity-80">{t("estimatedBadge")}</p>
    <p className={"mt-2 break-words leading-tight " + (known ? "font-display text-3xl tabular-nums" : "text-base font-medium")} aria-live="polite">
      {known ? formatMoney(amount, { currency: view!.currency!, locale, fractionDigits: 2 }) : t(discrepancy ? "reviewDifference" : tracking.loading ? "loading" : "notAvailable")}
    </p>
    <p className="mt-2 text-xs leading-relaxed opacity-80">{t("notSpendable")}</p>
    {view?.startedAt && <p className="mt-2 text-xs leading-relaxed opacity-80">{t("since", { date: formatDate(view.startedAt, { locale }) })}</p>}
    {stale && <p role="status" className="mt-2 text-xs font-medium">{t("staleHint")}</p>}
    <a href="#wallet-tracking" className="mt-3 inline-flex min-h-11 items-center text-xs font-medium underline underline-offset-4">{t("viewCalculation")}</a>
  </section>;
}
export function WalletTrackingPanel({ tracking }: { tracking: WalletTrackingController }) {
  const t = useTranslations("walletTracking");
  const locale = useLocale() as Locale;
  const [historyOpen, setHistoryOpen] = useState(false);
  const [editing, setEditing] = useState<"adjustment" | TrackingHistoryCandidate | null>(null);
  const [historyVersion, setHistoryVersion] = useState(0);
  const view = tracking.view;
  const money = (amount: number) => view?.currency ? formatMoney(amount, { currency: view.currency, locale, fractionDigits: 2 }) + " " + view.currency : formatNumber(amount / 100, { locale });
  const date = (raw: string) => formatDate(raw, { locale, timeZone: "America/Bogota" });
  const ready = Boolean(view?.trackingId && view.currency);
  const canAdjust = ready && !tracking.loading && (!tracking.pending || tracking.pending.path === "/adjustments");
  const reasons = view?.reasons.filter(reason => reason !== "earlier_excluded") ?? [];
  return <section id="wallet-tracking" aria-labelledby="wallet-tracking-title" aria-busy={tracking.loading} className="min-w-0 rounded-2xl border border-op-border bg-op-surface p-5 md:p-6">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 max-w-2xl"><h2 id="wallet-tracking-title" className="font-display text-2xl">{t("title")}</h2><p className="mt-2 text-sm leading-relaxed text-op-muted">{t("intro")}</p></div>
      <button type="button" className={button} onClick={() => void tracking.sync()} disabled={tracking.loading}>{t(tracking.loading ? "loading" : "refresh")}</button>
    </header>
    {tracking.error && <p role="alert" className="mt-4 rounded-xl bg-amber-50 p-3 text-sm leading-relaxed text-amber-950">{t(t.has("errors." + tracking.error) ? "errors." + tracking.error : "errors.tracking_unavailable")}</p>}
    {tracking.pending && <div role="status" className="mt-4 rounded-xl bg-amber-50 p-4 text-sm text-amber-950"><p>{t("pendingOperation")}</p><button className={button + " mt-3"} type="button" disabled={tracking.loading} onClick={() => void tracking.recover()}>{t("recoverOperation")}</button><p className="mt-2 text-xs leading-relaxed">{t("recoverHint")}</p></div>}
    {!view && <p role="status" className="mt-5 text-sm text-op-muted">{t(tracking.loading ? "starting" : "notAvailable")}</p>}
    {view && <>
      <div className="mt-5 flex flex-wrap gap-x-5 gap-y-2 border-y border-op-border py-3 text-xs text-op-muted">
        {view.mode && <p>{t("mode." + view.mode)}</p>}
        {view.startedAt && <p>{t("since", { date: date(view.startedAt) })}</p>}
        {view.lastComparedAt && <p>{t("lastCompared", { date: date(view.lastComparedAt) })}</p>}
      </div>
      <p className="mt-4 text-sm font-medium">{t("status." + view.status)}</p>
      {view.signedDifferenceCents !== null && view.signedDifferenceCents < 0 && <div role="status" className="mt-3 rounded-xl bg-amber-50 p-4 text-amber-950"><p className="text-sm font-medium">{t("negativeDifference", { amount: money(view.signedDifferenceCents) })}</p><p className="mt-2 text-xs leading-relaxed">{t("negativeHint")}</p></div>}
      {view.ambiguousOutgoingCount > 0 && <p className="mt-3 text-sm text-amber-900">{t("ambiguousOutgoing", { count: view.ambiguousOutgoingCount })}</p>}
      {view.excludedSourceCount > 0 && <p className="mt-3 text-sm text-op-muted">{t("excludedSources", { count: view.excludedSourceCount })}</p>}
      {reasons.length > 0 && <ul className="mt-3 space-y-1 text-xs leading-relaxed text-op-muted">{reasons.map(reason => <li key={reason}>{t(t.has("reasons." + reason) ? "reasons." + reason : "reasons.other")}</li>)}</ul>}
      {ready && <details className="mt-5 rounded-xl border border-op-border p-4" open>
        <summary className="cursor-pointer text-sm font-medium">{t("calculation")}</summary>
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
          {([
            ["openingPending", view.openingPendingCents], ["charges", view.totals.chargesCents],
            ["refunds", view.totals.refundsCents], ["outgoing", view.totals.effectiveOutgoingCents],
            ["fees", view.totals.registeredFeesCents], ["adjustments", view.totals.adjustmentsCents],
            ["historyIncluded", view.totals.incorporatedHistoryCents], ["baselineAvailable", view.baselineAvailableCents],
          ] as const).map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-xs text-op-muted">{t("breakdown." + label)}</dt><dd className="mt-1 break-words tabular-nums">{value === null ? t("notAvailable") : money(value)}</dd></div>)}
        </dl>
        {view.snapshotAt && <p className="mt-4 text-xs text-op-muted">{t("snapshotAt", { date: date(view.snapshotAt) })}</p>}
        <p className="mt-3 text-xs leading-relaxed text-op-muted">{t("calculationHint")}</p>
      </details>}
      <div className="mt-5 flex flex-wrap gap-3">
        <button type="button" className={button} disabled={!ready || tracking.loading} onClick={() => setHistoryOpen(v => !v)}>{t(historyOpen ? "hideEarlier" : "reviewEarlier")}</button>
        <button type="button" className={button} disabled={!canAdjust} onClick={event => { event.currentTarget.focus({ preventScroll: true }); setEditing("adjustment"); }}>{t("addAdjustment")}</button>
      </div>
      {historyOpen && ready && <TrackingHistory key={view.trackingId + ":" + historyVersion} tracking={tracking} onChoose={candidate => setEditing(candidate)} />}
    </>}
    {editing && view?.trackingId && <TrackingMutationDialog tracking={tracking} candidate={editing === "adjustment" ? undefined : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setHistoryVersion(v => v + 1); }} />}
  </section>;
}
