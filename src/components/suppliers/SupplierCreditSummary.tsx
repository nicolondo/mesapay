"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatDate, formatMoney } from "@/lib/format";
import { creditNoteListHref, type CreditNoteListPage } from "@/lib/erp/supplierCreditNoteList";
import { KIND_LABEL_KEY } from "@/lib/erp/supplierCreditNotes";

/**
 * Notas crédito del proveedor en su detalle: saldo a favor vigente, total
 * recibido y las últimas notas, con el enlace a Compras › Notas crédito
 * filtrado por el proveedor. No pinta nada si el proveedor no tiene notas.
 */
export function SupplierCreditSummary({ supplierId, currency }: { supplierId: string; currency: string }) {
  const t = useTranslations("opSupplierCredit");
  const locale = useLocale() as Locale;
  const [list, setList] = useState<CreditNoteListPage | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/operator/supplier-credit-notes?proveedor=${encodeURIComponent(supplierId)}`, { cache: "no-store" });
        if (!r.ok) return;
        const j = (await r.json()) as CreditNoteListPage;
        if (!cancelled) setList(j);
      } catch {
        // Sin red: la sección no aparece.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supplierId]);
  if (!list || list.total === 0) return null;
  const money = (c: number) => formatMoney(c, { currency, locale, fractionDigits: "auto" });
  return (
    <section className="mb-4" aria-label={t("supplierSectionTitle")}>
      <div className="flex items-center justify-between mb-2">
        <span className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">{t("supplierSectionTitle")}</span>
        <a href={creditNoteListHref({ supplier: supplierId })} className="text-[11px] font-medium text-op-muted hover:text-ink">
          {t("seeNotes")}
        </a>
      </div>
      <div className="grid grid-cols-2 gap-2 mb-2">
        <div className="rounded-2xl border border-op-border px-3 py-2">
          <div className="font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted">{t("balanceLabel")}</div>
          <div className="text-sm font-semibold tabular-nums">{money(list.summary.availableCents)}</div>
        </div>
        <div className="rounded-2xl border border-op-border px-3 py-2">
          <div className="font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted">{t("kindAgreement")}</div>
          <div className="text-sm tabular-nums">{money(list.summary.byKind.agreement)}</div>
        </div>
      </div>
      <div className="border border-op-border rounded-2xl overflow-hidden">
        {list.rows.slice(0, 5).map((r) => (
          <a
            key={r.id}
            href={creditNoteListHref({ supplier: supplierId, nota: r.id })}
            className="flex items-center justify-between gap-3 px-3 py-2 border-b border-op-border last:border-b-0 hover:bg-op-bg"
          >
            <div className="min-w-0">
              <div className={"text-sm font-mono truncate" + (r.status === "voided" ? " line-through text-op-muted" : "")}>{r.number}</div>
              <div className="text-[11px] text-op-muted truncate">
                {[t(KIND_LABEL_KEY[r.kind]), formatDate(r.date, { locale, timeStyle: undefined }), r.agreement].filter(Boolean).join(" · ")}
              </div>
            </div>
            <div className="text-right shrink-0">
              <div className="text-sm tabular-nums">{money(r.totalCents)}</div>
              {r.availableCents > 0 && <div className="text-[11px] text-[#2F6B4F] tabular-nums">{t("balanceShort", { amount: money(r.availableCents) })}</div>}
            </div>
          </a>
        ))}
      </div>
    </section>
  );
}
