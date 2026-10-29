"use client";

import { useLocale, useTranslations } from "next-intl";
import { MoneyInput } from "@/components/MoneyInput";
import { formatMoney } from "@/lib/format";
import type { Locale } from "@/i18n/config";
import { usePaymentMethodLabel } from "@/lib/usePaymentMethodLabel";
import type { MixedPaymentAllocation, MixedPaymentBudget } from "@/lib/payments/mixedAmount";

export type ApprovedPaymentView = { id: string; method: string; amountCents: number; tipCents: number };

export function MixedPaymentPanel({ budget, allocation, value, onChange, onRemaining, payments, disabled, pending, inFlight, currency }: {
  budget: MixedPaymentBudget;
  allocation: MixedPaymentAllocation;
  value: string;
  onChange: (value: string) => void;
  onRemaining: () => void;
  payments: ApprovedPaymentView[];
  disabled: boolean;
  pending: boolean;
  inFlight: boolean;
  currency: string;
}) {
  const t = useTranslations("pay.mixed");
  const locale = useLocale() as Locale;
  const methodLabel = usePaymentMethodLabel();
  const money = (cents: number) => formatMoney(cents, { locale, currency, fractionDigits: cents % 100 ? 2 : 0 });
  return (
    <section aria-label={t("summary")} className="mt-4 rounded-2xl border border-hairline bg-paper p-5 space-y-4">
      <p className="text-sm text-muted">{t("instructions")}</p>
      {payments.length > 0 && <div>
        <h2 className="text-sm font-medium mb-2">{t("received")}</h2>
        <ul className="divide-y divide-hairline">
          {payments.map(payment => <li key={payment.id} className="flex justify-between gap-3 py-2 text-sm">
            <span>{methodLabel(payment.method)}</span>
            <span className="font-mono tabular">{money(payment.amountCents)}</span>
          </li>)}
        </ul>
      </div>}
      {budget.ok && <div className="border-y border-hairline py-3 space-y-1" aria-live="polite">
        <div className="flex justify-between gap-3 font-medium"><span>{t("remaining")}</span><span>{money(budget.outstandingGrossCents)}</span></div>
        <p className="text-xs text-muted">{t("tipBudget", { target: money(budget.targetTipCents), remaining: money(budget.remainingTipCents) })}</p>
      </div>}
      <div>
        <label htmlFor="mixed-payment-amount" className="block text-sm font-medium mb-2">{t("amount")}</label>
        <MoneyInput id="mixed-payment-amount" value={value} onChange={onChange} fractionDigits={2}
          disabled={disabled || pending} aria-describedby="mixed-payment-help mixed-payment-error"
          aria-invalid={value !== "" && !allocation.ok}
          className="w-full h-12 rounded-xl border border-hairline bg-ivory px-4 text-lg font-mono disabled:opacity-50" />
        <p id="mixed-payment-help" className="mt-2 text-xs text-muted">{t("amountHint")}</p>
        <button type="button" onClick={onRemaining} disabled={disabled || pending || !budget.ok}
          className="mt-3 min-h-10 px-3 rounded-full border border-hairline text-sm disabled:opacity-50">{t("useRemaining")}</button>
      </div>
      {allocation.ok && <p className="text-sm text-muted">{t("afterPayment", { amount: money(allocation.remainingGrossCents) })}</p>}
      <p id="mixed-payment-error" role={allocation.ok || value === "" ? undefined : "alert"} className="text-sm text-danger">
        {!allocation.ok && value !== "" ? t(`errors.${allocation.error}`) : null}
      </p>
      {pending && <p className="text-sm text-terracotta">{t(inFlight ? "inFlight" : "pending")}</p>}
    </section>
  );
}
