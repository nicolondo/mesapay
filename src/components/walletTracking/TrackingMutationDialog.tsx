"use client";

import { useRef, useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { AppDialog } from "@/components/ui/AppDialog";
import { MoneyInput } from "@/components/MoneyInput";
import { formatDate, formatMoney } from "@/lib/format";
import type { Locale } from "@/i18n/config";
import type { TrackingAdjustmentInput, TrackingHistoryCandidate } from "@/lib/walletTracking/contracts";
import { parseTrackingAmount, trackingErrorCode } from "./client";
import type { TrackingMutation, WalletTrackingController } from "./useWalletTracking";

const field = "mt-1 w-full min-w-0 rounded-xl border border-op-border bg-op-bg px-3 py-3 text-sm";
const secondary = "min-h-11 rounded-full border border-op-border px-4 py-2 text-sm disabled:opacity-50";
const primary = "min-h-11 rounded-full bg-ink px-5 py-2 text-sm font-medium text-bone disabled:opacity-50";
export function TrackingMutationDialog({ tracking, candidate, onClose, onSaved }: { tracking: WalletTrackingController; candidate?: TrackingHistoryCandidate; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations("walletTracking");
  const locale = useLocale() as Locale;
  const [kind, setKind] = useState<TrackingAdjustmentInput["kind"]>("fee");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [historicalToken, setHistoricalToken] = useState<string | null>(null);
  const [review, setReview] = useState<TrackingMutation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const path = candidate ? "/history" : "/adjustments";
  const currency = tracking.view?.currency;
  const cutoff = tracking.view?.startedAt ? formatDate(tracking.view.startedAt, { locale, timeZone: "America/Bogota" }) : null;
  const historicalMaximum = candidate ? candidate.maxOpeningPendingCents ?? candidate.amountCents - candidate.refundedCents : null;
  const historicalChanged = !candidate && Boolean(tracking.view?.reasons.includes("historical_sources_changed"));
  const money = (cents: number) => formatMoney(cents, { currency: currency!, locale, fractionDigits: 2 }) + " " + currency;
  function prepare(event: FormEvent) {
    event.preventDefault(); setError(null);
    const trackingId = tracking.view?.trackingId;
    const cents = parseTrackingAmount(amount, !candidate && kind === "correction");
    if (!trackingId || !currency) { setError("tracking_not_configured"); return; }
    if (historicalToken && historicalToken !== tracking.view?.historicalChangeToken) { setError("tracking_history_changed"); return; }
    if (cents === null || (candidate ? cents <= 0 || cents > historicalMaximum! : (cents === 0 && !(kind === "correction" && historicalToken)) || (kind !== "correction" && cents < 0)) || reason.trim().length < 5) { setError("invalid_payload"); return; }
    if (tracking.pending && (tracking.pending.path !== path || tracking.pending.trackingId !== trackingId)) { setError("pending_operation"); return; }
    const base = { trackingId, idempotencyKey: tracking.pending?.key ?? crypto.randomUUID(), reason: reason.trim() };
    setReview(candidate ? { ...base, source: candidate.source, sourceId: candidate.sourceId, remainingCents: cents } : { ...base, kind, amountCents: cents, ...(historicalToken ? { acknowledgeHistoricalChanges: true, historicalChangeToken: historicalToken } : {}) });
  }
  async function save() {
    if (!review || lock.current) return;
    lock.current = true; setBusy(true); setError(null);
    try { await tracking.mutate(path, review); onSaved(); }
    catch (error) { setError(trackingErrorCode(error)); }
    finally { lock.current = false; setBusy(false); }
  }
  const canEdit = !busy && (!tracking.pending || ["invalid_payload", "tracking_source_ineligible", "tracking_source_not_found", "unsafe_money", "tracking_history_changed"].includes(error ?? ""));
  const title = t(candidate ? "incorporateTitle" : "adjustmentTitle");
  return <AppDialog label={title} placement="center" onClose={() => { if (!busy) onClose(); }} dismissOnBackdrop={false} className="rounded-2xl bg-op-surface text-op-text"><div className="p-5 md:p-6">
    <header className="flex items-start justify-between gap-4"><h2 className="font-display text-2xl">{title}</h2><button type="button" className="min-h-11 px-2 text-sm text-op-muted" disabled={busy} onClick={onClose}>{t("close")}</button></header>
    <p className="mt-3 text-sm leading-relaxed text-op-muted">{t(candidate ? "historyFormHint" : "adjustmentHint")}</p>
    {error && <p role="alert" className="mt-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-950">{t(t.has("errors." + error) ? "errors." + error : "errors.tracking_unavailable")}</p>}
    {review ? <div className="mt-5 space-y-4">
      <h3 className="text-sm font-medium">{t("reviewTitle")}</h3>
      <dl className="space-y-3 rounded-xl bg-op-bg p-4 text-sm">
        {candidate && cutoff && <div><dt className="text-op-muted">{t("historyCutoffLabel")}</dt><dd className="mt-1">{cutoff}</dd></div>}
        <div><dt className="text-op-muted">{t("operation")}</dt><dd className="mt-1">{"kind" in review ? t("kind." + review.kind) : t("incorporateTitle")}</dd></div>
        <div><dt className="text-op-muted">{t(candidate ? "remainingAmount" : "amount")}</dt><dd className="mt-1 font-mono text-xl">{money("remainingCents" in review ? review.remainingCents : review.amountCents)}</dd></div>
        <div><dt className="text-op-muted">{t("reason")}</dt><dd className="mt-1 whitespace-pre-wrap break-words">{review.reason}</dd></div>
      </dl>
      {historicalChanged && "kind" in review && <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-950">{t(review.acknowledgeHistoricalChanges ? "historicalChangesAcknowledged" : "historicalChangesNotAcknowledged")}</p>}
      <p className="text-xs leading-relaxed text-op-muted">{t(candidate ? "historyConfirmationHint" : "confirmationHint")}</p>
      <div className="flex flex-wrap gap-3"><button type="button" className={primary} onClick={save} disabled={busy}>{t(busy ? "saving" : tracking.pending ? "retrySameOperation" : "confirmSave")}</button><button type="button" className={secondary} onClick={() => { setReview(null); if (error === "tracking_history_changed") { setHistoricalToken(null); setError(null); void tracking.sync(); } }} disabled={!canEdit}>{t("edit")}</button></div>
    </div> : <form onSubmit={prepare} className="mt-5 space-y-4">
      {candidate && cutoff && <div className="rounded-xl bg-op-bg p-3 text-sm"><p className="text-xs text-op-muted">{t("historyCutoffLabel")}</p><p className="mt-1 font-medium">{cutoff}</p></div>}
      {!candidate && <label className="block text-sm">{t("adjustmentKind")}<select className={field} value={kind} onChange={event => { setKind(event.target.value as typeof kind); setAmount(""); }}>{(["fee", "external_credit", "external_debit", "correction"] as const).map(value => <option key={value} value={value}>{t("kind." + value)}</option>)}</select></label>}
      {candidate && <p className="text-xs text-op-muted">{t("chargeMaximum", { amount: money(historicalMaximum!) })}</p>}
      <label className="block text-sm">{t(candidate ? "remainingAmount" : "amount")}<MoneyInput value={amount} onChange={setAmount} fractionDigits={2} allowNegative={!candidate && kind === "correction"} className={field} required ariaLabel={t(candidate ? "remainingAmount" : "amount")} /><span className="mt-1 block text-xs text-op-muted">{currency}</span></label>
      <label className="block text-sm">{t("reason")}<textarea value={reason} onChange={event => setReason(event.target.value)} className={field} rows={3} required minLength={5} maxLength={500} /></label>
      {historicalChanged && <div className="space-y-3 rounded-xl bg-amber-50 p-4 text-sm text-amber-950"><p>{t("historicalChangeNotice")}</p><label className="flex items-start gap-3"><input type="checkbox" checked={Boolean(historicalToken)} disabled={tracking.loading || !tracking.view?.historicalChangeToken} onChange={event => setHistoricalToken(event.target.checked ? tracking.view?.historicalChangeToken ?? null : null)} className="mt-1 h-4 w-4 shrink-0" /><span>{t("ackHistoricalChanges")}</span></label></div>}
      <button type="submit" disabled={tracking.loading} className={primary}>{t("reviewOperation")}</button>
    </form>}
  </div></AppDialog>;
}
