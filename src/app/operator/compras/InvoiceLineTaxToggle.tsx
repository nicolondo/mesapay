"use client";

import { useId } from "react";
import { useTranslations } from "next-intl";
import type { InvoiceTaxBasis } from "@/lib/erp/invoiceAmounts";

export function InvoiceLineTaxToggle({ basis, manual, onChange }: {
  basis: InvoiceTaxBasis;
  manual?: boolean;
  onChange: (included: boolean) => void;
}) {
  const t = useTranslations("opErp");
  const hintId = useId();
  const unknown = basis === "unknown";
  return (
    <div className={`rounded-xl border px-3 py-2 ${unknown ? "border-terracotta/40 bg-terracotta/5" : "border-op-border bg-op-surface"}`}>
      <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-medium">
        <input type="checkbox" className="h-5 w-5 shrink-0 accent-ink"
          aria-label={t("invLineTaxIncluded")} aria-describedby={hintId}
          aria-checked={unknown ? "mixed" : basis === "gross"}
          ref={node => { if (node) node.indeterminate = unknown; }}
          checked={basis === "gross"} onChange={event => onChange(event.target.checked)} />
        <span>{t("invLineTaxIncluded")}</span>
      </label>
      <div id={hintId} className="space-y-1 text-xs leading-relaxed">
        <p className={unknown ? "font-medium text-terracotta" : "font-medium text-op-muted"}>
          {t(unknown ? "invLineTaxUncertain" : manual ? "invLineTaxManual" : basis === "gross" ? "invLineTaxDetectedGross" : "invLineTaxDetectedNet")}
        </p>
        <p className="text-op-muted">
          {t(unknown ? "invLineTaxConfirmHint" : basis === "gross" ? "invLineTaxIncludedHint" : "invLineTaxExcludedHint")}
        </p>
      </div>
      {unknown && <button type="button" onClick={() => onChange(false)}
        className="mt-2 min-h-11 text-left text-xs font-medium underline underline-offset-4">
        {t("invLineConfirmNet")}
      </button>}
    </div>
  );
}
