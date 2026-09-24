"use client";

import { useEffect, useId, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { MoneyInput } from "@/components/MoneyInput";
import { formatMoney, pesosToCents } from "@/lib/format";
import type { Locale } from "@/i18n/config";
import type { BillingCustomerRecord } from "./types";

type MoneyAccount = { code: string; name: string };

/** Hoy en formato yyyy-mm-dd (hora Colombia, como el resto del ERP). */
function todayIso(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Bogota" });
}

/**
 * "Abonar": registra un pago del cliente a su deuda de crédito. Monto
 * prellenado con la deuda, fecha, cuenta de dinero donde entró la plata
 * (caja, banco, pasarela — del plan del comercio) y nota.
 */
export function CreditPaymentSheet({ customer, currency, onClose, onSaved }: {
  customer: BillingCustomerRecord;
  currency: string;
  onClose: () => void;
  onSaved: (debtAfterCents: number) => void;
}) {
  const t = useTranslations("billingCustomers");
  const locale = useLocale() as Locale;
  const id = useId();
  const debt = customer.debtCents ?? 0;
  const [amount, setAmount] = useState(String(debt / 100));
  const [paidAt, setPaidAt] = useState(todayIso());
  const [accountCode, setAccountCode] = useState("");
  const [note, setNote] = useState("");
  const [accounts, setAccounts] = useState<MoneyAccount[] | null>(null);
  const [accountsFailed, setAccountsFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const money = (cents: number) => formatMoney(cents, { currency, locale });

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const response = await fetch("/api/operator/customer-credit/payment-accounts", { signal: controller.signal });
        if (!response.ok) throw new Error("accounts_failed");
        const data = (await response.json()) as { accounts: MoneyAccount[] };
        if (controller.signal.aborted) return;
        setAccounts(data.accounts);
        // Caja general primero: es donde suele entrar un abono en el local.
        setAccountCode(data.accounts.find(a => a.code === "110505")?.code ?? data.accounts[0]?.code ?? "");
      } catch { if (!controller.signal.aborted) setAccountsFailed(true); }
    })();
    return () => controller.abort();
  }, []);

  const amountCents = pesosToCents(Number(amount) || 0);
  const canSubmit = !busy && amountCents > 0 && amountCents <= debt && accountCode !== "" && /^\d{4}-\d{2}-\d{2}$/.test(paidAt);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/operator/billing-customers/${customer.id}/credit-payments`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ amountCents, paidAt, accountCode, note: note.trim() || null }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const code = typeof data.error === "string" ? data.error : "";
        setError(code === "exceeds_debt" ? t("abonoErr_exceeds_debt", { amount: money(data.debtCents ?? debt) }) : code === "account_invalid" ? t("abonoErr_account_invalid") : code === "invalid" || code === "invalid_date" ? t("abonoErr_invalid") : t("abonoErr_generic"));
        return;
      }
      onSaved(data.debtAfterCents ?? Math.max(0, debt - amountCents));
    } catch { setError(t("abonoErr_generic")); }
    finally { setBusy(false); }
  }

  const inputClass = "w-full min-w-0 rounded-xl border border-hairline bg-ivory px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-terracotta/40";
  return <div className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6" onClick={onClose}>
    <form onSubmit={submit} onClick={e => e.stopPropagation()} aria-label={t("abonoTitle", { name: customer.customerName })} className="w-full md:max-w-md bg-paper rounded-t-3xl md:rounded-3xl border border-hairline p-5 space-y-4 max-h-[90dvh] overflow-y-auto">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-muted">{t("debtValue", { amount: money(debt) })}</div>
          <h2 className="font-display text-2xl mt-1">{t("abonoTitle", { name: customer.customerName })}</h2>
        </div>
        <button type="button" onClick={onClose} disabled={busy} className="text-muted text-sm shrink-0" aria-label={t("close")}>{"✕"}</button>
      </div>
      <fieldset disabled={busy} className="space-y-4">
        <div>
          <label htmlFor={`${id}-amount`} className="block text-sm text-muted mb-1.5">{t("abonoAmount")}</label>
          <MoneyInput id={`${id}-amount`} value={amount} onChange={setAmount} className={inputClass} />
          {amountCents > debt && <p className="text-xs text-danger mt-1">{t("abonoErr_exceeds_debt", { amount: money(debt) })}</p>}
        </div>
        <div>
          <label htmlFor={`${id}-date`} className="block text-sm text-muted mb-1.5">{t("abonoDate")}</label>
          <input id={`${id}-date`} type="date" value={paidAt} max={todayIso()} onChange={e => setPaidAt(e.target.value)} className={inputClass} required />
        </div>
        <div>
          <label htmlFor={`${id}-account`} className="block text-sm text-muted mb-1.5">{t("abonoAccount")}</label>
          {accountsFailed ? <p role="alert" className="text-sm text-danger">{t("accountsLoadError")}</p> : <select id={`${id}-account`} value={accountCode} onChange={e => setAccountCode(e.target.value)} className={inputClass} disabled={!accounts}>
            {!accounts && <option value="">{t("loading")}</option>}
            {accounts?.map(a => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
          </select>}
        </div>
        <div>
          <label htmlFor={`${id}-note`} className="block text-sm text-muted mb-1.5">{t("abonoNote")}</label>
          <input id={`${id}-note`} type="text" value={note} maxLength={300} onChange={e => setNote(e.target.value)} className={inputClass} />
        </div>
      </fieldset>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <button type="submit" disabled={!canSubmit} className="w-full min-h-[48px] rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-40">{busy ? t("abonoSaving") : t("abonoSave")}</button>
    </form>
  </div>;
}
