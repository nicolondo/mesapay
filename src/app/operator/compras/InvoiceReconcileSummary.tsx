"use client";

// «Factura vs MESAPAY»: cada renglón del pie de la factura frente a lo que
// se va a guardar, con ✓ o la diferencia exacta. Va en el pie fijo de la
// revisión, así los totales se ven mientras se recorren las líneas: en
// escritorio como una tabla horizontal de tres filas; en el celular, una
// línea con el total y el detalle desplegable. Si algo no cuadra (o una
// columna de impuesto no se pudo comprobar), guardar exige marcar que se
// revisó: nunca se da por buena en silencio.
import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatMoney } from "@/lib/format";
import type { ReconcileRow, ReconcileRowKey } from "@/lib/erp/invoiceReconcile";
import { useMediaQuery } from "./oc/useMediaQuery";

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
  const wide = useMediaQuery("(min-width: 768px)");
  const [expanded, setExpanded] = useState(false);
  // Cents are shown only when the amount has them (a rounding of $0,32 must
  // never read as "$0").
  const money = (cents: number) => formatMoney(cents, { currency, locale, ...(cents % 100 !== 0 ? { fractionDigits: 2 as const } : {}) });
  const signed = (cents: number) => `${cents > 0 ? "+" : "−"} ${money(Math.abs(cents))}`;
  const amount = (row: ReconcileRow, cents: number) => row.key === "adjustment" && cents !== 0 ? signed(cents) : money(cents);
  const total = rows.find(row => row.key === "total");
  const printedTotal = total?.printedCents ?? null;
  const status = (row: ReconcileRow) => row.diffCents == null ? null : row.diffCents === 0
    ? <span className="text-[#2E7D32]" aria-label={t("invRecMatchesAria")}>{"✓"}</span>
    : <span className="text-terracotta font-medium">{signed(row.computedCents - row.printedCents!)}</span>;

  return (
    <section aria-labelledby="inv-reconcile-title" className="space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <h3 id="inv-reconcile-title" className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
          {t("invRecTitle")}
        </h3>
        {needsAck ? (
          <span className="px-2 h-5 inline-flex items-center rounded-full text-[10px] font-medium bg-[#C98A2E]/15 text-[#7F5A1F]">
            {t("invRecPending")}
          </span>
        ) : printedTotal != null && (
          <span className="px-2 h-5 inline-flex items-center rounded-full text-[10px] font-medium bg-[#2E7D32]/15 text-[#2E7D32]">
            {t("invRecAllMatch")}
          </span>
        )}
        {roundingSuggestion != null && (
          <button type="button" onClick={onUseRounding} className="text-[11px] font-medium text-terracotta hover:underline">
            {t("invRecUseRounding", { amount: signed(roundingSuggestion) })}
          </button>
        )}
        <button type="button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}
          className="ml-auto text-[11px] font-medium text-op-muted hover:text-ink">
          {t(expanded ? "invRecHideDetail" : "invRecShowDetail")}
        </button>
      </div>

      {wide ? (
        // Concepts as columns: Factura / MESAPAY / ✓ or difference.
        <div role="table" aria-labelledby="inv-reconcile-title" className="text-[11px] tabular-nums grid gap-x-3 gap-y-0.5"
          style={{ gridTemplateColumns: `auto repeat(${rows.length}, minmax(0, 1fr))` }}>
          <div role="row" className="contents">
            <span role="columnheader" />
            {rows.map(row => (
              <span key={row.key} role="columnheader" className={"text-right text-[10px] text-op-muted truncate" + (row.key === "total" ? " font-medium text-ink" : "")}>
                {t(ROW_LABEL[row.key])}
              </span>
            ))}
          </div>
          <div role="row" className="contents">
            <span role="rowheader" className="text-op-muted">{t("invRecInvoice")}</span>
            {rows.map(row => (
              <span key={row.key} role="cell" className="text-right text-op-muted truncate">
                {row.printedCents == null ? t("invRecNotPrinted") : amount(row, row.printedCents)}
              </span>
            ))}
          </div>
          <div role="row" className="contents">
            <span role="rowheader" className="text-op-muted">{t("invRecMesapay")}</span>
            {rows.map(row => (
              <span key={row.key} role="cell" className={"text-right truncate" + (row.key === "total" ? " font-medium text-xs" : "")}>
                {amount(row, row.computedCents)}{" "}{row.diffCents === 0 && status(row)}
              </span>
            ))}
          </div>
          {rows.some(row => row.diffCents != null && row.diffCents !== 0) && (
            <div role="row" className="contents">
              <span role="rowheader" className="text-op-muted">{t("invRecDifferenceRow")}</span>
              {rows.map(row => (
                <span key={row.key} role="cell" className="text-right truncate text-[10px]">
                  {row.diffCents != null && row.diffCents !== 0 ? status(row) : null}
                </span>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="text-[11px] tabular-nums">
          {(expanded ? rows : rows.filter(row => row.key === "total" || (row.diffCents != null && row.diffCents !== 0))).map(row => (
            <div key={row.key} className={"grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-2 py-0.5" + (row.key === "total" ? " font-medium text-xs" : "")}>
              <span className="truncate">{t(ROW_LABEL[row.key])}</span>
              <span className="text-right text-op-muted">
                {row.printedCents == null ? t("invRecNotPrinted") : amount(row, row.printedCents)}
              </span>
              <span className="text-right">{amount(row, row.computedCents)} {status(row)}</span>
            </div>
          ))}
        </div>
      )}

      {expanded && (
        <div className="text-[11px] text-op-muted space-y-0.5">
          {adjustmentCents !== 0 && (
            <button type="button" onClick={onClearRounding} className="font-medium hover:text-ink">
              {t("invRecClearRounding")}
            </button>
          )}
          {printedTotal == null && <p>{t("invRecNoPrintedTotal")}</p>}
          {reasons.length > 0 && (
            <ul className="list-disc pl-4 space-y-0.5 text-[#7F5A1F]">
              {reasons.map(reason => <li key={reason}>{reason}</li>)}
            </ul>
          )}
        </div>
      )}
      {needsAck && (
        <label className="flex items-start gap-2 rounded-lg border border-[#C98A2E]/30 bg-[#C98A2E]/5 px-2 py-1.5 text-xs text-ink">
          <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-ink" checked={acked}
            onChange={event => onAck(event.target.checked)} />
          <span>
            {t("invRecAck")}
            {!expanded && reasons.length > 0 && <span className="block text-[10px] text-[#7F5A1F]">{reasons[0]}{reasons.length > 1 ? ` (+${reasons.length - 1})` : ""}</span>}
          </span>
        </label>
      )}
    </section>
  );
}
