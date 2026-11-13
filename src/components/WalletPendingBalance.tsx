"use client";

import { useId } from "react";
import { useLocale, useTranslations } from "next-intl";
import { formatDate, formatMoney } from "@/lib/format";
import type { Locale } from "@/i18n/config";
import type { WalletPendingBalance as PendingBalance } from "@/lib/payments/walletPending";

/** A missing pending amount is unknown, never zero or additional spending power. */
export function WalletPendingBalance({ balance, currency = "COP", loading = false, failed = false, onRetry, dark = false, activityHref }: {
  balance: Partial<PendingBalance> | null;
  currency?: string;
  loading?: boolean;
  failed?: boolean;
  onRetry: () => void;
  dark?: boolean;
  activityHref?: string;
}) {
  const t = useTranslations("walletPending");
  const locale = useLocale() as Locale;
  const titleId = useId();
  const reported = !failed && balance?.pendingStatus === "reported"
    && typeof balance.pendingCents === "number"
    && Number.isSafeInteger(balance.pendingCents) && balance.pendingCents >= 0;
  const unavailable = failed || balance?.pendingStatus === "unavailable"
    || (balance?.pendingStatus === "reported" && !reported);
  const waiting = loading && !balance;
  const date = reported && balance?.pendingUpdatedAt ? new Date(balance.pendingUpdatedAt) : null;
  const muted = dark ? "text-bone/75" : "text-op-muted";
  return <section aria-labelledby={titleId} className={`min-w-0 rounded-xl border p-4 ${dark ? "border-bone/20 bg-bone/5 text-bone" : "border-op-border bg-op-bg text-op-text"}`}>
    <h3 id={titleId} className={`text-sm ${muted}`}>{t("title")}</h3>
    <p className={`mt-2 break-words leading-tight ${reported ? "font-display text-3xl tabular-nums" : "text-base font-medium"}`} aria-live="polite">
      {waiting ? t("loading") : reported ? formatMoney(balance.pendingCents!, { currency, locale }) : t(unavailable ? "unavailable" : "notReported")}
    </p>
    <p className={`mt-2 text-xs leading-relaxed ${muted}`}>{t("notSpendable")}</p>
    {!waiting && !reported && !unavailable && <p className={`mt-2 text-xs leading-relaxed ${muted}`}>{t("notReportedHint")}</p>}
    {!waiting && !reported && activityHref && <a href={activityHref} className="mt-3 inline-flex min-h-11 items-center text-xs font-medium underline underline-offset-4">{t("viewActivity")}</a>}
    {date && Number.isFinite(date.getTime()) && <p className={`mt-2 text-xs ${muted}`}>{t("updatedAt", { date: formatDate(date, { locale, timeZone: "America/Bogota" }) })}</p>}
    {!waiting && unavailable && <div className="mt-3">
      <p role="alert" className={`text-xs leading-relaxed ${dark ? "text-amber-100" : "text-amber-900"}`}>{t("unavailableHint")}</p>
      <button type="button" onClick={onRetry} disabled={loading} className={`mt-3 min-h-11 rounded-full border px-3 py-2 text-xs font-medium disabled:opacity-50 ${dark ? "border-bone/30 text-bone hover:bg-bone/10" : "border-op-border text-op-text hover:bg-op-surface"}`}>{t(loading ? "loading" : "retry")}</button>
    </div>}
  </section>;
}
