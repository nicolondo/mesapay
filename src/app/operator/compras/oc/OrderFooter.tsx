"use client";

import { useState, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatMoney } from "@/lib/format";

export type FooterTotals = {
  subtotalCents: number;
  discountCents: number;
  ivaCents: number;
  incCents: number;
  /** Retenciones por tipo (solo con «Ya recibí esta mercancía»). */
  retentions: { label: string; cents: number }[] | null;
  payableCents: number;
  productCount: number;
};

/**
 * Pie fijo de «Nueva orden»: los totales siempre a la vista y el botón
 * principal. En escritorio, una franja con Subtotal · Descuento · IVA · INC
 * · Retenciones · Total; en el celular, el total y el botón, con el detalle
 * desplegable encima.
 */
export function OrderFooter({
  totals,
  currency,
  receivedNow,
  desktop,
  actions,
  hint,
  message,
}: {
  totals: FooterTotals;
  currency: string;
  receivedNow: boolean;
  desktop: boolean;
  /** Botones (Cancelar + principal), o la confirmación de descartar. */
  actions: ReactNode;
  /** Atajos de teclado (solo escritorio). */
  hint?: ReactNode;
  /** Error o aviso sobre el pie. */
  message?: ReactNode;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const [open, setOpen] = useState(false);
  const money = (c: number) => formatMoney(c, { currency, locale, fractionDigits: "auto" });
  const retained = (totals.retentions ?? []).reduce((s, r) => s + r.cents, 0);
  const rows: { label: string; value: string; tone?: "ok" | "muted" }[] = [
    { label: t("subtotalLabel"), value: money(totals.subtotalCents) },
    ...(totals.discountCents > 0 ? [{ label: t("discountLabel"), value: `− ${money(totals.discountCents)}`, tone: "ok" as const }] : []),
    { label: t("taxLabel"), value: money(totals.ivaCents) },
    ...(totals.incCents > 0 ? [{ label: t("ocIncShort"), value: money(totals.incCents) }] : []),
    ...(totals.retentions
      ? totals.retentions.length > 0 && retained > 0
        ? totals.retentions.map((r) => ({ label: r.label, value: `− ${money(r.cents)}`, tone: "muted" as const }))
        : [{ label: t("invLineRetentions"), value: money(0), tone: "muted" as const }]
      : []),
  ];
  const totalLabel = receivedNow ? t("invTaxGrandTotal") : t("orderTotalLabel");

  if (desktop) {
    return (
      <div className="shrink-0 border-t border-op-border bg-op-surface" data-testid="oc-footer">
        {message}
        <div className="flex items-center gap-6 px-6 py-3">
          <div className="hidden xl:block min-w-0 flex-1 text-[11px] text-op-muted">{hint}</div>
          <dl className="flex items-baseline gap-x-5 gap-y-1 flex-wrap justify-end ml-auto">
            {rows.map((r) => (
              <div key={r.label} className="flex items-baseline gap-1.5">
                <dt className="text-[11px] text-op-muted">{r.label}</dt>
                <dd className={"text-sm tabular-nums " + (r.tone === "ok" ? "text-ok" : "text-op-text")}>{r.value}</dd>
              </div>
            ))}
            <div className="flex items-baseline gap-2 pl-5 border-l border-op-border">
              <dt className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">{totalLabel}</dt>
              <dd className="font-display text-2xl leading-none tabular-nums" data-testid="oc-total">{money(totals.payableCents)}</dd>
            </div>
          </dl>
          <div className="flex items-center gap-2 shrink-0">{actions}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="shrink-0 border-t border-op-border bg-op-surface pb-[env(safe-area-inset-bottom)]" data-testid="oc-footer">
      {message}
      {open && (
        <dl className="px-4 pt-3 space-y-1.5" id="oc-mobile-breakdown">
          {rows.map((r) => (
            <div key={r.label} className="flex items-baseline justify-between">
              <dt className="text-xs text-op-muted">{r.label}</dt>
              <dd className={"text-sm tabular-nums " + (r.tone === "ok" ? "text-ok" : "")}>{r.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="oc-mobile-breakdown"
          className="min-w-0 flex-1 text-left min-h-[44px]"
        >
          <span className="flex items-center gap-1 font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
            {totalLabel}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={"transition-transform " + (open ? "rotate-180" : "")}>
              <path d="m6 15 6-6 6 6" />
            </svg>
          </span>
          <span className="block font-display text-2xl leading-tight tabular-nums" data-testid="oc-total">{money(totals.payableCents)}</span>
          <span className="block text-[11px] text-op-muted">{t("ocProductsCount", { count: totals.productCount })}</span>
        </button>
        <div className="flex items-center gap-2 shrink-0">{actions}</div>
      </div>
    </div>
  );
}
