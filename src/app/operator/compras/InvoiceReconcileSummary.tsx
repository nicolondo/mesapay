"use client";

// «Factura vs MESAPAY»: cada renglón del pie de la factura frente a lo que
// se va a guardar, con ✓ o la diferencia exacta. Si algo no cuadra (o una
// columna de impuesto no se pudo comprobar), guardar exige marcar que se
// revisó: nunca se da por buena en silencio.
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatMoney } from "@/lib/format";
import type { ReconcileRow, ReconcileRowKey } from "@/lib/erp/invoiceReconcile";

const ROW_LABEL: Record<ReconcileRowKey, string> = {
  subtotal: "subtotalLabel",
  discount: "discountLabel",
  iva: "taxLabel",
  consumo: "invRecConsumo",
  retentions: "invLineRetentions",
  adjustment: "invRecAdjustment",
  total: "invTaxGrandTotal",
};

export function InvoiceReconcileSummary({
  rows, currency, reasons, needsAck, acked, onAck, roundingSuggestion, onUseRounding, adjustmentCents, onClearRounding,
}: {
  rows: ReconcileRow[];
  currency: string;
  /** Motivos (ya traducidos) por los que la factura queda por revisar. */
  reasons: string[];
  needsAck: boolean;
  acked: boolean;
  onAck: (acked: boolean) => void;
  /** Diferencia del total que cabe como ajuste al peso (null si no aplica). */
  roundingSuggestion: number | null;
  onUseRounding: () => void;
  adjustmentCents: number;
  onClearRounding: () => void;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const money = (cents: number) => formatMoney(cents, { currency, locale });
  const signed = (cents: number) => `${cents > 0 ? "+" : "−"} ${money(Math.abs(cents))}`;
  const printedTotal = rows.find(row => row.key === "total")?.printedCents ?? null;
  return (
    <section aria-labelledby="inv-reconcile-title" className={`rounded-xl border p-3 space-y-2 ${needsAck ? "border-[#C98A2E]/40 bg-[#C98A2E]/5" : "border-op-border bg-op-bg/50"}`}>
      <div className="flex items-center justify-between gap-2">
        <h3 id="inv-reconcile-title" className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
          {t("invRecTitle")}
        </h3>
        {!needsAck && printedTotal != null && (
          <span className="px-2 h-5 inline-flex items-center rounded-full text-[10px] font-medium bg-[#2E7D32]/15 text-[#2E7D32]">
            {t("invRecAllMatch")}
          </span>
        )}
      </div>
      <div role="table" aria-labelledby="inv-reconcile-title" className="text-[11px] tabular-nums">
        <div role="row" className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-3 pb-1 border-b border-op-border text-[10px] text-op-muted">
          <span role="columnheader">{t("invRecConcept")}</span>
          <span role="columnheader" className="text-right">{t("invRecInvoice")}</span>
          <span role="columnheader" className="text-right">{t("invRecMesapay")}</span>
        </div>
        {rows.map(row => {
          const differs = row.diffCents != null && row.diffCents !== 0;
          return (
            <div key={row.key} role="row"
              className={`grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-3 py-1 border-b border-op-border/60 last:border-b-0 ${row.key === "total" ? "font-medium text-xs" : ""}`}>
              <span role="rowheader" className="min-w-0 break-words">{t(ROW_LABEL[row.key])}</span>
              <span role="cell" className="text-right text-op-muted">
                {row.printedCents == null ? t("invRecNotPrinted") : row.key === "adjustment" ? signed(row.printedCents) : money(row.printedCents)}
              </span>
              <span role="cell" className="text-right">
                {row.key === "adjustment" ? (row.computedCents === 0 ? money(0) : signed(row.computedCents)) : money(row.computedCents)}
                {row.diffCents === 0 && <span className="ml-1 text-[#2E7D32]" aria-label={t("invRecMatchesAria")}>{"✓"}</span>}
              </span>
              {differs && (
                <span className="col-span-3 text-right text-[10px] font-medium text-terracotta">
                  {t("invRecDifference", { amount: signed(row.computedCents - row.printedCents!) })}
                </span>
              )}
            </div>
          );
        })}
      </div>
      {roundingSuggestion != null && (
        <button type="button" onClick={onUseRounding} className="mp-btn mp-btn--secondary mp-btn--sm">
          {t("invRecUseRounding", { amount: signed(roundingSuggestion) })}
        </button>
      )}
      {adjustmentCents !== 0 && (
        <button type="button" onClick={onClearRounding} className="block text-[11px] font-medium text-op-muted hover:text-ink">
          {t("invRecClearRounding")}
        </button>
      )}
      {printedTotal == null && <p className="text-[11px] text-op-muted">{t("invRecNoPrintedTotal")}</p>}
      {needsAck && (
        <div role="status" className="space-y-2 text-[11px] text-[#7F5A1F]">
          <p className="font-medium">{t("invRecNeedsReview")}</p>
          {reasons.length > 0 && (
            <ul className="list-disc pl-4 space-y-0.5">
              {reasons.map(reason => <li key={reason}>{reason}</li>)}
            </ul>
          )}
          <label className="flex items-start gap-2 rounded-lg border border-[#C98A2E]/30 bg-op-surface p-2 text-xs text-ink">
            <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-ink" checked={acked}
              onChange={event => onAck(event.target.checked)} />
            <span>{t("invRecAck")}</span>
          </label>
        </div>
      )}
    </section>
  );
}
