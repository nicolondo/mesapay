"use client";

import { useEffect, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { billingDocument, type BillingCustomerRecord } from "./types";

/** Only mounted in staff checkout. Customer records never reach diner pages. */
export function CustomerPicker({ onSelect }: { onSelect: (customer: BillingCustomerRecord) => void }) {
  const t = useTranslations("billingCustomers");
  const id = useId();
  const [query, setQuery] = useState("");
  const [customers, setCustomers] = useState<BillingCustomerRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState("");
  useEffect(() => {
    if (query.trim().length < 2) return;
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
  }, [query]);
  function change(value: string) { setQuery(value); setCustomers([]); setFailed(false); setSelected(""); setLoading(value.trim().length >= 2); }
  return <div className="rounded-xl border border-hairline bg-ivory p-3">
    <label htmlFor={id} className="block text-sm font-medium mb-1.5">{t("pickerLabel")}</label>
    <input id={id} type="search" autoComplete="off" value={query} maxLength={120} onChange={e => change(e.target.value)} placeholder={t("searchPlaceholder")} className="w-full rounded-lg border border-hairline bg-paper px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-terracotta/40" />
    <p className="text-xs text-muted mt-1.5">{t("pickerHint")}</p>
    {selected && <p role="status" className="text-xs text-success mt-2">{t("selected", { name: selected })}</p>}
    {query.trim().length >= 2 && (failed ? <p role="alert" className="text-xs text-danger mt-2">{t("loadError")}</p> : loading ? <p role="status" className="text-xs text-muted mt-2">{t("loading")}</p> : customers.length === 0 ? <p className="text-xs text-muted mt-2">{t("noResults")}</p> : <ul className="max-h-56 overflow-auto space-y-1.5 mt-3">
      {customers.map(customer => <li key={customer.id}><button type="button" aria-label={t("useCustomer", { name: customer.customerName })} onClick={() => { onSelect(customer); setSelected(customer.customerName); setQuery(""); setCustomers([]); }} className="w-full rounded-lg border border-hairline bg-paper p-3 text-left hover:border-terracotta focus-visible:ring-2 focus-visible:ring-terracotta">
        <span className="block text-sm font-medium break-words">{customer.customerName}</span><span className="block text-xs text-muted mt-1">{customer.docType} {billingDocument(customer)} · {customer.city}</span>
      </button></li>)}
    </ul>)}
  </div>;
}
