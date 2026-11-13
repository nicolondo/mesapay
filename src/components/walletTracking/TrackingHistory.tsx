"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatDate, formatMoney, formatNumber } from "@/lib/format";
import type { TrackingHistoryCandidate } from "@/lib/walletTracking/contracts";
import { readTrackingHistory, trackingErrorCode, trackingRequest, TrackingRequestError } from "./client";
import type { WalletTrackingController } from "./useWalletTracking";

export function TrackingHistory({ tracking, onChoose }: { tracking: WalletTrackingController; onChoose: (candidate: TrackingHistoryCandidate) => void }) {
  const t = useTranslations("walletTracking");
  const incoming = useTranslations("walletIncoming");
  const locale = useLocale() as Locale;
  const [rows, setRows] = useState<TrackingHistoryCandidate[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { surface, scopeId } = tracking;
  const trackingId = tracking.view?.trackingId;
  const load = useCallback(async (next?: string, signal?: AbortSignal) => {
    if (!scopeId || !trackingId) return;
    setBusy(true); setError(null);
    try {
      const raw = await trackingRequest(surface, scopeId, "/history", { query: { ...(next ? { cursor: next } : {}), limit: "20" }, signal });
      const page = readTrackingHistory(raw, surface, scopeId);
      if (page.trackingId !== trackingId) throw new TrackingRequestError("account_changed");
      if (!signal?.aborted) { setRows(old => next ? [...old, ...page.candidates.filter(row => !old.some(existing => existing.source === row.source && existing.sourceId === row.sourceId))] : page.candidates); setCursor(page.nextCursor); }
    } catch (error) { if (!signal?.aborted) setError(trackingErrorCode(error)); }
    finally { if (!signal?.aborted) setBusy(false); }
  }, [surface, scopeId, trackingId]);
  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => { if (!controller.signal.aborted) void load(undefined, controller.signal); });
    return () => controller.abort();
  }, [load]);
  const money = (cents: number, currency: string | null) => currency ? formatMoney(cents, { currency, locale, fractionDigits: 2 }) + " " + currency : formatNumber(cents / 100, { locale });
  return <section aria-label={t("earlierTitle")} className="mt-6 border-t border-op-border pt-5">
    <h3 className="text-base font-medium">{t("earlierTitle")}</h3><p className="mt-2 text-xs leading-relaxed text-op-muted">{t("earlierHint")}</p>
    {error && <p role="alert" className="mt-3 text-sm text-amber-900">{t(t.has("errors." + error) ? "errors." + error : "errors.tracking_unavailable")}</p>}
    {busy && !rows.length && <p role="status" className="mt-4 text-sm text-op-muted">{t("loading")}</p>}
    {!busy && !error && !rows.length && <p className="mt-4 text-sm text-op-muted">{t("historyEmpty")}</p>}
    <ul className="mt-4 divide-y divide-op-border">{rows.map(row => <li key={row.source + ":" + row.sourceId} className="flex flex-wrap items-start justify-between gap-4 py-4">
      <div className="min-w-0 flex-1"><p className="text-sm font-medium">{incoming("sources." + row.source)}</p><p className="mt-1 text-xs text-op-muted">{incoming(row.dateBasis === "record" ? "recordDate" : "chargeDate", { date: formatDate(row.occurredAt, { locale }) })}</p><p className="mt-1 text-xs text-op-muted">{t("sourceReference", { reference: row.sourceId.slice(-8) })}</p><p className="mt-2 font-mono text-sm">{money(row.amountCents, row.currency)}</p>{!row.currency && <p className="mt-1 text-xs text-op-muted">{incoming("currencyUnknown")}</p>}{row.refundedCents > 0 && <p className="mt-1 text-xs text-op-muted">{t("historyRefund", { amount: money(row.refundedCents, row.currency) })}</p>}{row.incorporatedCents !== null && <p className="mt-1 text-xs">{t("alreadyIncorporated", { amount: money(row.incorporatedCents, row.currency) })}</p>}{row.reason && <p className="mt-2 text-xs leading-relaxed text-op-muted">{t(t.has("historyReasons." + row.reason) ? "historyReasons." + row.reason : "historyReasons.other")}</p>}</div>
      <button type="button" disabled={!row.eligible || tracking.loading || Boolean(tracking.pending && tracking.pending.path !== "/history")} className="min-h-11 rounded-full border border-op-border px-4 py-2 text-sm disabled:opacity-50" onClick={event => { event.currentTarget.focus({ preventScroll: true }); onChoose(row); }}>{t("incorporate")}</button>
    </li>)}</ul>
    {(cursor || error) && <button type="button" className="mt-4 min-h-11 rounded-full border border-op-border px-4 text-sm disabled:opacity-50" disabled={busy} onClick={() => void load(cursor ?? undefined)}>{t(busy ? "loading" : error ? "retry" : "moreEarlier")}</button>}
  </section>;
}
