"use client";

import { useTranslations, useLocale } from "next-intl";
import { formatMoney, formatDate } from "@/lib/format";
import { currencyForCountry } from "@/lib/billing/subscription";
import type { Locale } from "@/i18n/config";
import type { MembershipMethod } from "@prisma/client";

type SubscriptionInfo = {
  status: string;
  cardBrand: string | null;
  cardLast4: string | null;
  cardExpMonth: number | null;
  cardExpYear: number | null;
  nextChargeAtIso: string | null;
};

type PaymentRow = {
  id: string;
  createdAtIso: string;
  periodStartIso: string;
  periodEndIso: string;
  amountCents: number;
  method: MembershipMethod;
  kind: string;
};

type Props = {
  plan: string;
  monthlyPriceCents: number;
  periodEndsAtIso: string | null;
  statusKey: "suspended" | "canceled" | "overdue" | "active";
  country: string | null;
  subscription: SubscriptionInfo | null;
  payments: PaymentRow[];
};

function statusI18nKey(
  key: Props["statusKey"],
): "statusSuspended" | "statusCanceled" | "statusOverdue" | "statusActive" {
  switch (key) {
    case "suspended":
      return "statusSuspended";
    case "canceled":
      return "statusCanceled";
    case "overdue":
      return "statusOverdue";
    default:
      return "statusActive";
  }
}

function statusTint(key: string): string {
  switch (key) {
    case "statusActive":
      return "bg-ok/15 text-ok";
    case "statusOverdue":
      return "bg-[#C98A2E]/20 text-[#8F6828]";
    case "statusSuspended":
    case "statusCanceled":
      return "bg-danger/15 text-danger";
    default:
      return "bg-paper text-op-muted";
  }
}

function methodKey(method: MembershipMethod): string {
  switch (method) {
    case "kushki_card":
      return "methodKushkiCard";
    case "manual_cash":
      return "methodManualCash";
    case "manual_transfer":
      return "methodManualTransfer";
    case "wompi":
      return "methodWompi";
    default:
      return "methodManualCash";
  }
}

function kindKey(kind: string): string {
  switch (kind) {
    case "initial":
      return "kindInitial";
    case "recurring":
      return "kindRecurring";
    case "proration":
      return "kindProration";
    default:
      return "kindManual";
  }
}

export function SubscriptionClient({
  plan,
  monthlyPriceCents,
  periodEndsAtIso,
  statusKey,
  country,
  subscription,
  payments,
}: Props) {
  const t = useTranslations("opSubscription");
  const locale = useLocale() as Locale;
  const currency = currencyForCountry(country);

  const i18nKey = statusI18nKey(statusKey);

  function fmtMoney(cents: number) {
    return formatMoney(cents, { currency, locale });
  }

  function fmtDate(iso: string) {
    return formatDate(iso, { locale, dateStyle: "medium" });
  }

  return (
    <div className="space-y-6">
      {/* Plan activo */}
      <section className="bg-op-surface border border-op-border rounded-2xl p-5">
        <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-3">
          {t("planKicker")}
        </div>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <div className="font-display text-2xl capitalize">{plan}</div>
            <div className="text-sm text-op-muted mt-0.5">
              {t("planPrice", { amount: fmtMoney(monthlyPriceCents) })}
            </div>
          </div>
          <span
            className={
              "px-3 h-6 inline-flex items-center rounded-full text-[11px] font-medium " +
              statusTint(i18nKey)
            }
          >
            {t(i18nKey)}
          </span>
        </div>
        {subscription?.nextChargeAtIso && (
          <div className="mt-3 text-sm text-op-muted">
            {t("nextChargeLabel")}
            {": "}
            <span className="text-op-text">
              {fmtDate(subscription.nextChargeAtIso)}
            </span>
          </div>
        )}
        {!subscription?.nextChargeAtIso && periodEndsAtIso && (
          <div className="mt-3 text-sm text-op-muted">
            {t("renewsLabel")}
            {": "}
            <span className="text-op-text">{fmtDate(periodEndsAtIso)}</span>
          </div>
        )}
      </section>

      {/* Método de pago */}
      <section className="bg-op-surface border border-op-border rounded-2xl p-5">
        <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-3">
          {t("methodKushkiCard")}
        </div>
        {subscription &&
        subscription.status !== "canceled" &&
        subscription.cardLast4 ? (
          <div className="text-sm text-op-text">
            {subscription.cardBrand
              ? subscription.cardBrand.charAt(0).toUpperCase() +
                subscription.cardBrand.slice(1)
              : ""}
            {" •••• "}
            {subscription.cardLast4}
            {subscription.cardExpMonth != null &&
            subscription.cardExpYear != null ? (
              <span className="text-op-muted ml-2">
                {"· "}
                {String(subscription.cardExpMonth).padStart(2, "0")}
                {"/"}
                {String(subscription.cardExpYear).slice(-2)}
              </span>
            ) : null}
          </div>
        ) : (
          <div className="text-sm text-op-muted">{t("noAutoDebit")}</div>
        )}
      </section>

      {/* Historial de pagos */}
      <section className="bg-op-surface border border-op-border rounded-2xl p-5">
        <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-3">
          {t("historyKicker")}
        </div>
        {payments.length === 0 ? (
          <div className="text-sm text-op-muted">{t("historyEmpty")}</div>
        ) : (
          <div className="overflow-x-auto -mx-1">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-op-muted text-[11px] border-b border-op-border">
                  <th className="pb-2 pr-4 font-medium">{t("colDate")}</th>
                  <th className="pb-2 pr-4 font-medium">{t("colPeriod")}</th>
                  <th className="pb-2 pr-4 font-medium text-right">
                    {t("colAmount")}
                  </th>
                  <th className="pb-2 pr-4 font-medium">{t("colMethod")}</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr
                    key={p.id}
                    className="border-b border-op-border/60 last:border-0"
                  >
                    <td className="py-2 pr-4 text-op-text whitespace-nowrap">
                      {fmtDate(p.createdAtIso)}
                    </td>
                    <td className="py-2 pr-4 text-op-muted whitespace-nowrap text-xs">
                      {fmtDate(p.periodStartIso)}
                      {" – "}
                      {fmtDate(p.periodEndIso)}
                    </td>
                    <td className="py-2 pr-4 text-op-text text-right tabular-nums whitespace-nowrap">
                      {fmtMoney(p.amountCents)}
                    </td>
                    <td className="py-2 pr-4 text-op-muted">
                      <div>{t(methodKey(p.method))}</div>
                      <div className="text-[10px] text-op-muted/70">
                        {t(kindKey(p.kind))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
