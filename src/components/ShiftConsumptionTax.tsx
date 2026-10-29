"use client";

import { useTranslations } from "next-intl";
import { fmtCOP } from "@/lib/format";

type Props = {
  consumptionTaxCents: number;
  taxPendingPayments: number;
  className?: string;
};

/** Informational breakdown: the tax is already part of the shift's receipts. */
export function ShiftConsumptionTax({ consumptionTaxCents, taxPendingPayments, className = "" }: Props) {
  const t = useTranslations("opShifts");
  return (
    <div role="group" aria-label={t("consumptionTax")} className={`rounded-xl border border-op-border p-3 ${className}`}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">{t("consumptionTax")}</p>
          <p className="mt-1 text-xs text-op-muted">{t("consumptionTaxIncluded")}</p>
        </div>
        <p className="font-mono text-lg tabular-nums">{fmtCOP(consumptionTaxCents)}</p>
      </div>
      {taxPendingPayments > 0 && (
        <p role="status" className="mt-2 text-xs text-amber-800 print:text-black">
          {t("consumptionTaxPending", { count: taxPendingPayments })}
        </p>
      )}
    </div>
  );
}
