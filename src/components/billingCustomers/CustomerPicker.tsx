"use client";

import { useEffect, useId, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { formatMoney } from "@/lib/format";
import type { Locale } from "@/i18n/config";
import { CUSTOMER_PICKER_PAGE_SIZE } from "@/lib/billingCustomerList";
import { billingDocument, discountBpsToPctText, type BillingCustomerRecord } from "./types";

/**
 * Only mounted in staff checkout. Customer records never reach diner pages.
 *
 * Buscador de clientes de facturación del cobro ("Buscar cliente
 * registrado"), de la factura antes de cobrar y de los bonos. Busca en el
 * servidor sobre TODOS los clientes del comercio (antes la API cortaba en
 * 50 por nombre sin avisar): trae tandas de 20, con el documento exacto y
 * los nombres que empiezan por lo escrito primero, dice cuántos hay en total
 * y deja ver más.
 *
 * `creditOnly` deja sólo los clientes con crédito habilitado (cobro a
 * crédito). Cada fila muestra lo que debe y su descuento, que es lo que el
 * cajero necesita ver antes de elegir.
 */
export function CustomerPicker({ onSelect, creditOnly = false, currency = "COP" }: {
  onSelect: (customer: BillingCustomerRecord) => void;
  creditOnly?: boolean;
  currency?: string;
}) {
  const t = useTranslations("billingCustomers");
  const locale = useLocale() as Locale;
  const id = useId();
  const [query, setQuery] = useState("");
  const [customers, setCustomers] = useState<BillingCustomerRecord[]>([]);
  const [total, setTotal] = useState(0);
  // Tandas pedidas para la búsqueda actual (1 = la primera); "Ver más" suma una.
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState("");
  const money = (cents: number) => formatMoney(cents, { currency, locale });
  useEffect(() => {
    if (query.trim().length < 2) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true); setFailed(false);
      try {
        const qs = new URLSearchParams({ q: query, sort: "relevance", page: String(pages), pageSize: String(CUSTOMER_PICKER_PAGE_SIZE) });
        if (creditOnly) qs.set("credit", "1");
        const response = await fetch(`/api/operator/billing-customers?${qs.toString()}`, { signal: controller.signal });
        if (!response.ok) throw new Error("lookup_failed");
        const data = await response.json();
        if (controller.signal.aborted) return;
        // La primera tanda reemplaza; las siguientes se agregan (sin repetir).
        setCustomers(previous => {
          if (pages === 1) return data.customers;
          const seen = new Set(previous.map(c => c.id));
          return [...previous, ...(data.customers as BillingCustomerRecord[]).filter(c => !seen.has(c.id))];
        });
        setTotal(typeof data.total === "number" ? data.total : data.customers.length);
      } catch { if (!controller.signal.aborted) setFailed(true); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }, pages === 1 ? 250 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, creditOnly, pages]);
  function change(value: string) { setQuery(value); setCustomers([]); setTotal(0); setPages(1); setFailed(false); setSelected(""); setLoading(value.trim().length >= 2); }
  return <div className="rounded-xl border border-hairline bg-ivory p-3">
    <label htmlFor={id} className="block text-sm font-medium mb-1.5">{t(creditOnly ? "pickerLabelCredit" : "pickerLabel")}</label>
    <input id={id} type="search" autoComplete="off" value={query} maxLength={120} onChange={e => change(e.target.value)} placeholder={t("searchPlaceholder")} className="w-full rounded-lg border border-hairline bg-paper px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-terracotta/40" />
    <p className="text-xs text-muted mt-1.5">{t(creditOnly ? "pickerHintCredit" : "pickerHint")}</p>
    {selected && <p role="status" className="text-xs text-success mt-2">{t("selected", { name: selected })}</p>}
    {query.trim().length >= 2 && (failed ? <p role="alert" className="text-xs text-danger mt-2">{t("loadError")}</p> : loading && customers.length === 0 ? <p role="status" className="text-xs text-muted mt-2">{t("loading")}</p> : customers.length === 0 ? <p className="text-xs text-muted mt-2">{t("noResults")}</p> : <><ul className="max-h-56 overflow-auto space-y-1.5 mt-3">
      {customers.map(customer => <li key={customer.id}><button type="button" aria-label={t("useCustomer", { name: customer.customerName })} onClick={() => { onSelect(customer); setSelected(customer.customerName); setQuery(""); setCustomers([]); setTotal(0); setPages(1); }} className="w-full rounded-lg border border-hairline bg-paper p-3 text-left hover:border-terracotta focus-visible:ring-2 focus-visible:ring-terracotta">
        <span className="block text-sm font-medium break-words">{customer.customerName}</span>
        <span className="block text-xs text-muted mt-1">{customer.docType} {billingDocument(customer)}{customer.city ? ` · ${customer.city}` : ""}</span>
        {(customer.creditEnabled || (customer.debtCents ?? 0) > 0 || customer.discountEnabled) && <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs mt-1">
          {customer.creditEnabled && <span className="text-muted">{t("creditBadge")}</span>}
          {(customer.debtCents ?? 0) > 0 && <span className="text-terracotta">{t("debtValue", { amount: money(customer.debtCents ?? 0) })}</span>}
          {customer.discountEnabled && customer.discountBps > 0 && <span className="text-success">{t("discountBadge", { pct: discountBpsToPctText(customer.discountBps) })}</span>}
        </span>}
      </button></li>)}
    </ul>
    {total > customers.length && <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
      <p role="status" className="text-xs text-muted">{t("pickerShowing", { shown: customers.length, total })}</p>
      <button type="button" disabled={loading} onClick={() => setPages(n => n + 1)} className="mp-btn mp-btn--secondary mp-btn--sm">{loading ? t("loading") : t("pickerMore")}</button>
    </div>}
    </>)}
  </div>;
}
