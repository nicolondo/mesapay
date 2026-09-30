"use client";

import { useEffect, useRef } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatMoney } from "@/lib/format";
import { displayUnitFor } from "@/lib/erp/units";
import type { StockResetSnapshot } from "@/lib/erp/stockTracking";

export function StockResetConfirmation({ snapshot, name, currency, busy, onCancel, onConfirm }: {
  snapshot: StockResetSnapshot;
  name: string;
  currency: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panel.current?.focus({ preventScroll: true });
    panel.current?.scrollIntoView({ block: "nearest" });
  }, [snapshot]);

  const unit = displayUnitFor(Math.abs(snapshot.qtyBase), snapshot.measureKind);
  // Base units are integers; three decimals preserve every gram/ml or
  // thousandth of a unit, even for negative stock.
  const quantity = `${new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(snapshot.qtyBase / unit.factor)} ${unit.symbol}`;
  const money = (value: number) => formatMoney(value, { currency, locale, fractionDigits: 2 });

  return (
    <div ref={panel} role="region" aria-label={t("stockResetTitle")} tabIndex={-1} className="space-y-4 outline-none">
      <h3 className="text-lg font-medium">{t("stockResetTitle")}</h3>
      <p className="text-sm text-op-muted leading-relaxed">{t("stockResetDescription", { name })}</p>
      <dl className="divide-y divide-op-border rounded-xl border border-op-border px-4">
        <div className="py-3 space-y-1">
          <dt className="text-xs text-op-muted">{t("stockResetQuantity")}</dt>
          <dd className="font-mono text-sm break-words">{quantity}{" → "}{`0 ${unit.symbol}`}</dd>
        </div>
        <div className="py-3 space-y-1">
          <dt className="text-xs text-op-muted">{t("stockResetValue")}</dt>
          <dd className="font-mono text-sm break-words">{money(snapshot.totalValueCents)}{" → "}{money(0)}</dd>
        </div>
      </dl>
      <p className="text-xs text-op-muted leading-relaxed">{t("stockResetHistory")}</p>
      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        <button type="button" disabled={busy} onClick={onCancel} className="mp-btn mp-btn--secondary">{t("stockResetCancel")}</button>
        <button type="button" disabled={busy} onClick={onConfirm} className="mp-btn mp-btn--primary">{busy ? t("saving") : t("stockResetConfirm")}</button>
      </div>
    </div>
  );
}
