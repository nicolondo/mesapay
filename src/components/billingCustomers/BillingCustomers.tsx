"use client";

import { useEffect, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { CustomerForm } from "./CustomerForm";
import { billingDocument, type BillingCustomerRecord } from "./types";

export function BillingCustomers() {
  const t = useTranslations("billingCustomers");
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [customers, setCustomers] = useState<BillingCustomerRecord[]>([]);
  const [editing, setEditing] = useState<BillingCustomerRecord | null | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState("");
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
  return <section aria-labelledby={`${searchId}-title`} className="mb-9">
    <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
      <div><h2 id={`${searchId}-title`} className="font-display text-2xl">{t("title")}</h2><p className="text-sm text-muted mt-1 max-w-xl">{t("subtitle")}</p></div>
      {editing === undefined && <button type="button" onClick={() => { setEditing(null); setNotice(""); }} className="rounded-full bg-ink text-bone px-5 py-2.5 text-sm font-medium">{t("create")}</button>}
    </div>
    {editing !== undefined && <div className="mb-5"><CustomerForm key={editing?.id ?? "new"} initial={editing} onCancel={() => setEditing(undefined)} onSaved={() => { setNotice(t(editing ? "updated" : "created")); setEditing(undefined); setQuery(""); setRevision(n => n + 1); }} /></div>}
    <label htmlFor={searchId} className="block text-sm text-muted mb-1.5">{t("search")}</label>
    <input id={searchId} type="search" value={query} maxLength={120} onChange={e => setQuery(e.target.value)} placeholder={t("searchPlaceholder")} className="w-full rounded-xl border border-hairline bg-paper px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-terracotta/40" />
    {notice && <p role="status" className="text-sm text-success mt-3">{notice}</p>}
    {failed ? <div role="alert" className="mt-4 text-sm text-danger">{t("loadError")} <button onClick={() => setRevision(n => n + 1)} className="underline">{t("retry")}</button></div> : loading ? <p role="status" className="py-5 text-sm text-muted">{t("loading")}</p> : customers.length === 0 ? <p className="mt-4 rounded-xl border border-dashed border-hairline p-6 text-sm text-muted">{t(query ? "noResults" : "empty")}</p> : <ul className="space-y-2 mt-4">
      {customers.map(customer => <li key={customer.id} className="flex items-start justify-between gap-3 rounded-xl border border-hairline bg-paper p-4">
        <div className="min-w-0"><h3 className="font-medium break-words">{customer.customerName}</h3><p className="text-xs font-mono text-muted mt-1 break-all">{customer.docType} {billingDocument(customer)}</p><p className="text-sm text-muted mt-2 break-words">{customer.address} · {customer.city}, {customer.department}</p><p className="text-xs text-muted mt-1 break-all">{customer.email}{customer.phone ? ` · ${customer.phone}` : ""}</p></div>
        <button type="button" disabled={editing !== undefined} aria-label={t("editCustomer", { name: customer.customerName })} onClick={() => { setEditing(customer); setNotice(""); }} className="shrink-0 rounded-full border border-hairline px-3 py-2 text-sm disabled:opacity-50">{t("edit")}</button>
      </li>)}
    </ul>}
    {!loading && !failed && customers.length === 50 && <p className="text-xs text-muted mt-3">{t("limitHint")}</p>}
  </section>;
}
