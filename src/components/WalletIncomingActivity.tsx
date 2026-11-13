"use client";

import { useEffect, useId, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatDate, formatMoney, formatNumber } from "@/lib/format";
import type { WalletIncomingCharge, WalletIncomingStatus, WalletIncomingView } from "@/lib/walletIncoming/contracts";

const STATUSES = new Set<WalletIncomingStatus>(["available", "permission_required", "credentials_missing", "unavailable", "unsupported"]);
const SOURCES = new Set(["order", "subscription", "reservation", "voucher"]);
const PAGE_SIZE = 10;
const currencyKnown = (value: unknown): value is string => typeof value === "string" && /^[A-Z]{3}$/.test(value);
const moneyValid = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function validView(raw: unknown): raw is WalletIncomingView {
  if (!raw || typeof raw !== "object") return false;
  const value = raw as WalletIncomingView;
  return STATUSES.has(value.status) && typeof value.periodStart === "string" && typeof value.periodEnd === "string"
    && (value.reportMode === null || value.reportMode === "sandbox" || value.reportMode === "production")
    && typeof value.queriedAt === "string" && typeof value.reportThrough === "string"
    && typeof value.localTruncated === "boolean" && typeof value.reportComplete === "boolean"
    && moneyValid(value.unmatchedReportCount) && Array.isArray(value.localCharges)
    && value.localCharges.every((charge) => charge && typeof charge.id === "string" && SOURCES.has(charge.source)
      && typeof charge.occurredAt === "string" && ["payment", "record"].includes(charge.dateBasis)
      && moneyValid(charge.amountCents) && moneyValid(charge.refundedCents)
      && (charge.currency === null || currencyKnown(charge.currency))
      && (!charge.report || (moneyValid(charge.report.grossCents) && Number.isSafeInteger(charge.report.netCents)
        && currencyKnown(charge.report.currency) && typeof charge.report.paymentDate === "string")));
}

/** Informational charges/report matching. It never increases spendable or pending wallet funds. */
export function WalletIncomingActivity({ surface, scopeId }: { surface: "admin" | "operator"; scopeId: string }) {
  const t = useTranslations("walletIncoming");
  const locale = useLocale() as Locale;
  const titleId = useId();
  const [reload, setReload] = useState(0);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [state, setState] = useState<{ data: WalletIncomingView | null; busy: boolean; error: string | null }>({ data: null, busy: true, error: null });
  const scopeField = surface === "admin" ? "accountId" : "restaurantId";
  const url = "/api/" + surface + "/wallet/incoming?" + new URLSearchParams({ [scopeField]: scopeId }).toString();

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    fetch(url, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const value = await response.json().catch(() => null);
        if (!response.ok) throw new Error(
          response.status === 429 ? "rateLimited"
            : value?.error === "account_changed" || value?.error === "restaurant_changed" ? "scopeChanged" : "requestFailed",
        );
        if (value?.[scopeField] !== scopeId) throw new Error("scopeChanged");
        if (!validView(value)) throw new Error("requestFailed");
        return value;
      })
      .then((data) => { if (active) setState({ data, busy: false, error: null }); })
      .catch((error) => {
        if (!active) return;
        const key = error instanceof Error && ["scopeChanged", "rateLimited"].includes(error.message) ? error.message : "requestFailed";
        setState({ data: null, busy: false, error: key });
      })
      .finally(() => clearTimeout(timer));
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [url, scopeField, scopeId, reload]);

  function refresh() {
    if (state.busy) return;
    setState((current) => ({ ...current, busy: true, error: null }));
    setVisibleCount(PAGE_SIZE);
    setReload((value) => value + 1);
  }
  function dateLabel(raw: string, dateOnly = false) {
    const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw + "T12:00:00Z" : raw);
    if (!Number.isFinite(date.getTime())) return t("dateUnknown");
    return formatDate(date, { locale, timeZone: "America/Bogota", dateStyle: "long", timeStyle: dateOnly ? undefined : "short" });
  }
  function amountLabel(cents: number, currency: string | null, exact = false) {
    return currencyKnown(currency) ? formatMoney(cents, { currency, locale, fractionDigits: exact ? 2 : undefined }) + " " + currency : formatNumber(cents / 100, { locale });
  }
  const { data, busy, error } = state;
  const unknownCurrencies = data?.localCharges.filter((charge) => !currencyKnown(charge.currency)).length ?? 0;
  const reportAvailable = data?.status === "available";
  const reportMatchesSafe = reportAvailable && data.reportComplete && !data.localTruncated;

  function chargeRow(charge: WalletIncomingCharge) {
    return <li key={charge.id} className="grid min-w-0 gap-4 py-5 md:grid-cols-[minmax(0,1fr)_minmax(0,.8fr)_minmax(0,1.2fr)]">
      <div className="min-w-0">
        <p className="font-medium text-op-text">{t("sources." + charge.source)}</p>
        <p className="mt-1 text-xs leading-relaxed text-op-muted">{t(charge.dateBasis === "record" ? "recordDate" : "chargeDate", { date: dateLabel(charge.occurredAt) })}</p>
      </div>
      <dl className="min-w-0 text-sm">
        <dt className="text-xs text-op-muted">{t(currencyKnown(charge.currency) ? "grossCharged" : "registeredAmount")}</dt>
        <dd className="mt-1 break-words font-medium tabular-nums">{amountLabel(charge.amountCents, charge.currency)}</dd>
        {!currencyKnown(charge.currency) && <dd className="mt-1 text-xs text-op-muted">{t("currencyUnknown")}</dd>}
        {charge.refundedCents > 0 && <><dt className="mt-2 text-xs text-op-muted">{t("refundRecorded")}</dt><dd className="mt-1 break-words tabular-nums">{amountLabel(charge.refundedCents, charge.currency)}</dd></>}
      </dl>
      <div className="min-w-0 rounded-xl bg-op-bg p-3 text-xs">
        {reportMatchesSafe && charge.report ? <dl className="space-y-2">
          <div className="flex flex-wrap justify-between gap-x-3 gap-y-1"><dt className="text-op-muted">{t("grossReported")}</dt><dd className="tabular-nums">{amountLabel(charge.report.grossCents, charge.report.currency, true)}</dd></div>
          <div className="flex flex-wrap justify-between gap-x-3 gap-y-1"><dt className="text-op-muted">{t("netReported")}</dt><dd className="font-medium tabular-nums">{amountLabel(charge.report.netCents, charge.report.currency, true)}</dd></div>
          <div><dt className="text-op-muted">{t("reportDate")}</dt><dd className="mt-1">{dateLabel(charge.report.paymentDate, true)}</dd></div>
        </dl> : <p className="leading-relaxed text-op-muted">{t(reportMatchesSafe ? "noMatch" : "reportNotChecked")}</p>}
      </div>
    </li>;
  }

  return <section id="wallet-incoming" aria-labelledby={titleId} aria-busy={busy} className="min-w-0 rounded-2xl border border-op-border bg-op-surface p-5 md:p-6">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 max-w-2xl"><h2 id={titleId} className="font-display text-2xl">{t("title")}</h2><p className="mt-2 text-sm leading-relaxed text-op-muted">{t("intro")}</p>{surface === "admin" && <p className="mt-2 text-xs leading-relaxed text-op-muted">{t("billingAccountHint")}</p>}</div>
      <button type="button" onClick={refresh} disabled={busy} className="min-h-11 shrink-0 rounded-full border border-op-border px-4 py-2 text-sm font-medium hover:bg-op-bg disabled:opacity-50">{t(busy ? "loading" : "refresh")}</button>
    </header>
    {busy && !data && <p role="status" className="mt-5 text-sm text-op-muted">{t("loadingDetail")}</p>}
    {error && <p role="alert" className="mt-5 rounded-xl bg-amber-50 p-4 text-sm leading-relaxed text-amber-950">{t("errors." + error)}</p>}
    {data && <>
      <div className="mt-5 flex flex-wrap gap-x-5 gap-y-2 border-y border-op-border py-3 text-xs text-op-muted">
        <p>{t("period", { start: dateLabel(data.periodStart, true), end: dateLabel(data.periodEnd, true) })}</p>
        <p className="font-medium text-op-text">{t("chargeCount", { count: data.localCharges.length })}</p>
        {data.reportMode && <p className="font-medium text-op-text">{t("reportMode." + data.reportMode)}</p>}
      </div>
      <p role={data.status === "available" ? "status" : undefined} className={"mt-4 rounded-xl p-3 text-sm leading-relaxed " + (data.status === "available" ? "bg-op-bg text-op-muted" : "bg-amber-50 text-amber-950")}>{t("statuses." + data.status)}</p>
      <p className="mt-3 text-xs leading-relaxed text-op-muted">{t("notWalletCredit")}</p>
      {unknownCurrencies > 0 && <p className="mt-3 text-xs leading-relaxed text-op-muted">{t("unknownCurrencyCount", { count: unknownCurrencies })}</p>}
      {data.localTruncated && <p className="mt-3 text-xs leading-relaxed text-op-muted">{t("localTruncated")}</p>}
      {reportAvailable && !data.reportComplete && <p className="mt-3 text-xs leading-relaxed text-op-muted">{t("reportIncomplete")}</p>}
      {reportAvailable && data.unmatchedReportCount > 0 && <p className="mt-3 text-xs leading-relaxed text-op-muted">{t("unmatchedReportCount", { count: data.unmatchedReportCount })}</p>}
      {data.localCharges.length ? <ul className="mt-3 divide-y divide-op-border">{data.localCharges.slice(0, visibleCount).map(chargeRow)}</ul>
        : <p className="py-6 text-sm text-op-muted">{t("empty")}</p>}
      {visibleCount < data.localCharges.length && <button type="button" className="mt-2 min-h-11 rounded-full border border-op-border px-4 text-sm hover:bg-op-bg" onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}>{t("showMore")}</button>}
      <div className="mt-4 space-y-2 border-t border-op-border pt-4 text-xs leading-relaxed text-op-muted">
        {reportAvailable && <p>{t("reportThrough", { date: dateLabel(data.reportThrough, true) })}</p>}
        <p>{t("queriedAt", { date: dateLabel(data.queriedAt) })}</p>
      </div>
    </>}
  </section>;
}
