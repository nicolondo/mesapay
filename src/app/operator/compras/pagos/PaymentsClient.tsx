"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatDate, formatMoney } from "@/lib/format";
import { EmptyState, Td, Th } from "@/components/billingCustomers/ListControls";
import { voucherNumberLabel } from "@/lib/erp/supplierPaymentPlan";
import type { SupplierPaymentRow } from "@/lib/erp/supplierPaymentQueries";
import { PayToSupplierSheet, type SupplierRef } from "./PayToSupplierSheet";

/** Lista de comprobantes de egreso + «Pagar a proveedor». */
export function PaymentsClient({
  list,
  suppliers,
  currency,
  initialPayFor,
  supplierFilter,
}: {
  list: { rows: SupplierPaymentRow[]; total: number; page: number; pageSize: number; totals: { paidCents: number; creditsCents: number; advanceCents: number } };
  suppliers: SupplierRef[];
  currency: string;
  initialPayFor: string | null;
  supplierFilter: string | null;
}) {
  const t = useTranslations("opSupplierPayment");
  const locale = useLocale() as Locale;
  const router = useRouter();
  const money = (c: number) => formatMoney(c, { currency, locale });
  const [open, setOpen] = useState<{ supplierId: string | null } | null>(initialPayFor ? { supplierId: initialPayFor } : null);
  const href = (id: string) => `/operator/compras/pagos/${encodeURIComponent(id)}`;
  const pages = Math.max(1, Math.ceil(list.total / list.pageSize));
  const qs = (page: number) => `/operator/compras/pagos?${new URLSearchParams({ ...(supplierFilter ? { proveedor: supplierFilter } : {}), pagina: String(page) })}`;

  return (
    <section className="@container space-y-4" aria-label={t("listTitle")}>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => setOpen({ supplierId: null })} className="mp-btn mp-btn--primary">
          {t("payButton")}
        </button>
      </div>
      <div className="grid grid-cols-1 @xl:grid-cols-3 gap-2">
        <Tile label={t("sumPaid")} value={money(list.totals.paidCents)} sub={t("vouchersCount", { n: list.total })} />
        <Tile label={t("sumCredits")} value={money(list.totals.creditsCents)} />
        <Tile label={t("sumAdvances")} value={money(list.totals.advanceCents)} />
      </div>
      {list.rows.length === 0 ? (
        <EmptyState title={t("emptyTitle")} body={t("emptyBody")} />
      ) : (
        <>
          <div className="hidden @3xl:block overflow-x-auto rounded-2xl border border-op-border bg-op-surface">
            <table className="w-full text-sm">
              <thead className="border-b border-op-border">
                <tr>
                  <Th>{t("colNumber")}</Th>
                  <Th>{t("colDate")}</Th>
                  <Th>{t("colSupplier")}</Th>
                  <Th>{t("colAccount")}</Th>
                  <Th align="right">{t("colCredits")}</Th>
                  <Th align="right">{t("colPaid")}</Th>
                </tr>
              </thead>
              <tbody>
                {list.rows.map((r) => (
                  <tr key={r.id} className={"border-b border-op-border/60 last:border-b-0 hover:bg-op-bg" + (r.status === "voided" ? " text-op-muted" : "")}>
                    <Td>
                      <Link href={href(r.id)} className="font-mono font-medium hover:underline">
                        {voucherNumberLabel(r.number)}
                      </Link>
                      {r.status === "voided" && <span className="ml-2 rounded-full bg-danger/10 px-2 py-0.5 text-[10px] font-medium text-danger">{t("voidedChip")}</span>}
                    </Td>
                    <Td className="whitespace-nowrap">{formatDate(r.date, { locale, timeStyle: undefined })}</Td>
                    <Td className="max-w-[16rem] truncate">{r.supplier.name}</Td>
                    <Td className="max-w-[14rem] truncate text-op-muted">{r.accountName ?? r.accountCode}</Td>
                    <Td align="right" className="tabular-nums whitespace-nowrap">{r.creditAppliedCents ? money(r.creditAppliedCents) : "—"}</Td>
                    <Td align="right" className="tabular-nums whitespace-nowrap font-medium">
                      {money(r.amountCents)}
                      {r.advanceCents > 0 && <div className="text-[11px] text-[#7F5A1F] font-normal">{t("advanceShort", { amount: money(r.advanceCents) })}</div>}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="@3xl:hidden rounded-2xl border border-op-border bg-op-surface overflow-hidden">
            {list.rows.map((r) => (
              <Link key={r.id} href={href(r.id)} className="block px-4 py-3 border-b border-op-border last:border-b-0 hover:bg-op-bg">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-mono text-sm font-medium">{voucherNumberLabel(r.number)}</div>
                    <div className="text-[12px] text-op-muted truncate">{[r.supplier.name, formatDate(r.date, { locale, timeStyle: undefined })].join(" · ")}</div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className={"text-sm font-medium tabular-nums" + (r.status === "voided" ? " line-through text-op-muted" : "")}>{money(r.amountCents)}</div>
                    {r.status === "voided" && <div className="text-[11px] text-danger">{t("voidedChip")}</div>}
                  </div>
                </div>
              </Link>
            ))}
          </div>
          {pages > 1 && (
            <div className="flex justify-between text-sm">
              {list.page > 1 ? <Link href={qs(list.page - 1)}>{t("prev")}</Link> : <span />}
              {list.page < pages ? <Link href={qs(list.page + 1)}>{t("next")}</Link> : <span />}
            </div>
          )}
        </>
      )}
      {open && (
        <PayToSupplierSheet
          suppliers={suppliers}
          currency={currency}
          initialSupplierId={open.supplierId}
          onClose={() => setOpen(null)}
          onSaved={(id) => {
            setOpen(null);
            router.push(href(id));
          }}
        />
      )}
    </section>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-2xl border border-op-border bg-op-surface px-4 py-3 min-w-0">
      <div className="font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted truncate">{label}</div>
      <div className="mt-1 text-lg tabular-nums truncate">{value}</div>
      {sub && <div className="text-[11px] text-op-muted truncate">{sub}</div>}
    </div>
  );
}
