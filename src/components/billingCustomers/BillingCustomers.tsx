"use client";

import { useEffect, useId, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { formatMoney } from "@/lib/format";
import type { Locale } from "@/i18n/config";
import { CustomerForm } from "./CustomerForm";
import { CreditPaymentSheet } from "./CreditPaymentSheet";
import { CreditStatementSheet } from "./CreditStatementSheet";
import { billingDocument, billingLocation, creditAvailableCents, discountBpsToPctText, type BillingCustomerRecord } from "./types";

/**
 * Listado de clientes de facturación. Además de la identidad, muestra el
 * crédito (deuda, límite, disponible) y el descuento de cada uno, con las
 * acciones "Abonar" y "Estado de cuenta" para los que tienen crédito o
 * deuda.
 */
export function BillingCustomers({ currency = "COP" }: { currency?: string }) {
  const t = useTranslations("billingCustomers");
  const locale = useLocale() as Locale;
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [customers, setCustomers] = useState<BillingCustomerRecord[]>([]);
  const [editing, setEditing] = useState<BillingCustomerRecord | null | undefined>(undefined);
  const [paying, setPaying] = useState<BillingCustomerRecord | null>(null);
  const [statement, setStatement] = useState<BillingCustomerRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState("");
  const money = (cents: number) => formatMoney(cents, { currency, locale });
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true); setFailed(false);
      try {
        const response = await fetch(`/api/operator/billing-customers?q=${encodeURIComponent(query)}`, { signal: controller.signal });
        if (!response.ok) throw new Error("lookup_failed");
        const data = await response.json();
        if (!controller.signal.aborted) setCustomers(data.customers);
      } catch { if (!controller.signal.aborted) setFailed(true); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, revision]);
  const refresh = () => setRevision(n => n + 1);
  return <section aria-labelledby={`${searchId}-title`} className="mb-9">
    <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
      <div><h2 id={`${searchId}-title`} className="font-display text-2xl">{t("title")}</h2><p className="text-sm text-muted mt-1 max-w-xl">{t("subtitle")}</p></div>
      {editing === undefined && <button type="button" onClick={() => { setEditing(null); setNotice(""); }} className="rounded-full bg-ink text-bone px-5 py-2.5 text-sm font-medium">{t("create")}</button>}
    </div>
    {editing !== undefined && <div className="mb-5"><CustomerForm key={editing?.id ?? "new"} initial={editing} onCancel={() => setEditing(undefined)} onSaved={() => { setNotice(t(editing ? "updated" : "created")); setEditing(undefined); setQuery(""); refresh(); }} /></div>}
    <label htmlFor={searchId} className="block text-sm text-muted mb-1.5">{t("search")}</label>
    <input id={searchId} type="search" value={query} maxLength={120} onChange={e => setQuery(e.target.value)} placeholder={t("searchPlaceholder")} className="w-full rounded-xl border border-hairline bg-paper px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-terracotta/40" />
    {notice && <p role="status" className="text-sm text-success mt-3">{notice}</p>}
    {failed ? <div role="alert" className="mt-4 text-sm text-danger">{t("loadError")} <button onClick={refresh} className="underline">{t("retry")}</button></div> : loading ? <p role="status" className="py-5 text-sm text-muted">{t("loading")}</p> : customers.length === 0 ? <p className="mt-4 rounded-xl border border-dashed border-hairline p-6 text-sm text-muted">{t(query ? "noResults" : "empty")}</p> : <ul className="space-y-2 mt-4">
      {customers.map(customer => {
        const debt = customer.debtCents ?? 0;
        const showCredit = customer.creditEnabled || debt > 0;
        const available = creditAvailableCents(customer);
        return <li key={customer.id} className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-hairline bg-paper p-4">
          <div className="min-w-0 flex-1">
            <h3 className="font-medium break-words">{customer.customerName}</h3>
            <p className="text-xs font-mono text-muted mt-1 break-all">{customer.docType} {billingDocument(customer)}</p>
            {billingLocation(customer) && <p className="text-sm text-muted mt-2 break-words">{billingLocation(customer)}</p>}
            <p className="text-xs text-muted mt-1 break-all">{customer.email}{customer.phone ? ` · ${customer.phone}` : ""}</p>
            {(showCredit || customer.discountEnabled) && <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs mt-2">
              {customer.creditEnabled && <span className="rounded-full border border-hairline px-2 py-0.5 text-muted">{t("creditBadge")}</span>}
              {customer.discountEnabled && customer.discountBps > 0 && <span className="rounded-full border border-hairline px-2 py-0.5 text-success">{t("discountBadge", { pct: discountBpsToPctText(customer.discountBps) })}</span>}
            </p>}
          </div>
          {showCredit && <div className="text-right shrink-0">
            <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">{t("debt")}</div>
            <div className={`font-display text-xl tabular ${debt > 0 ? "text-terracotta" : ""}`}>{debt > 0 ? money(debt) : t("noDebt")}</div>
            {customer.creditLimitCents != null && <div className="text-xs text-muted mt-0.5">{t("creditLimitValue", { amount: money(customer.creditLimitCents) })} · {t("availableValue", { amount: money(available ?? 0) })}</div>}
          </div>}
          <div className="flex flex-wrap gap-2 w-full sm:w-auto sm:flex-col sm:items-end">
            <button type="button" disabled={editing !== undefined} aria-label={t("editCustomer", { name: customer.customerName })} onClick={() => { setEditing(customer); setNotice(""); }} className="shrink-0 rounded-full border border-hairline px-3 py-2 text-sm disabled:opacity-50">{t("edit")}</button>
            {showCredit && <>
              <button type="button" disabled={debt <= 0} aria-label={t("addPaymentFor", { name: customer.customerName })} onClick={() => { setPaying(customer); setNotice(""); }} className="shrink-0 rounded-full bg-ink text-bone px-3 py-2 text-sm disabled:opacity-50">{t("addPayment")}</button>
              <button type="button" aria-label={t("statementFor", { name: customer.customerName })} onClick={() => setStatement(customer)} className="shrink-0 rounded-full border border-hairline px-3 py-2 text-sm">{t("statement")}</button>
            </>}
          </div>
        </li>;
      })}
    </ul>}
    {!loading && !failed && customers.length === 50 && <p className="text-xs text-muted mt-3">{t("limitHint")}</p>}
    {paying && <CreditPaymentSheet customer={paying} currency={currency} onClose={() => setPaying(null)} onSaved={debtAfter => { setPaying(null); setNotice(t("abonoSaved", { amount: money(debtAfter) })); refresh(); }} />}
    {statement && <CreditStatementSheet customer={statement} currency={currency} onClose={() => setStatement(null)} onChanged={refresh} />}
  </section>;
}
