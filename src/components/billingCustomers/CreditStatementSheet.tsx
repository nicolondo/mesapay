"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { formatDate, formatMoney } from "@/lib/format";
import type { Locale } from "@/i18n/config";
import type { BillingCustomerRecord } from "./types";

type Charge = {
  id: string;
  date: string;
  amountCents: number;
  tipCents: number;
  refundedCents: number;
  outstandingCents: number;
  orderShortCode: string;
  tableLabel: string | null;
};
type Abono = { id: string; date: string; amountCents: number; accountCode: string; note: string | null; createdByName: string | null };
type Statement = { debtCents: number; charges: Charge[]; payments: Abono[] };

type RawRow =
  | { key: string; date: string; kind: "cargo"; charge: Charge }
  | { key: string; date: string; kind: "abono"; abono: Abono };
type Row = RawRow & { balance: number };

/** Cargos y abonos en orden cronológico con saldo corrido. */
function buildRows(st: Statement): Row[] {
  const raw: RawRow[] = [
    ...st.charges.map(c => ({ key: `c:${c.id}`, date: c.date, kind: "cargo" as const, charge: c })),
    ...st.payments.map(a => ({ key: `a:${a.id}`, date: a.date, kind: "abono" as const, abono: a })),
  ];
  raw.sort((a, b) => a.date.localeCompare(b.date) || (a.kind === b.kind ? 0 : a.kind === "cargo" ? -1 : 1));
  let balance = 0;
  return raw.map(r => {
    balance += r.kind === "cargo" ? Math.max(0, r.charge.amountCents - r.charge.refundedCents) : -r.abono.amountCents;
    return { ...r, balance };
  });
}

/**
 * "Estado de cuenta": cargos (cuentas cobradas a crédito, con su código y
 * fecha), abonos (con la cuenta de dinero) y saldo corrido. Un abono errado
 * se reversa desde acá.
 */
export function CreditStatementSheet({ customer, currency, onClose, onChanged }: {
  customer: BillingCustomerRecord;
  currency: string;
  onClose: () => void;
  /** Se reversó un abono: el listado debe refrescar la deuda. */
  onChanged: () => void;
}) {
  const t = useTranslations("billingCustomers");
  const locale = useLocale() as Locale;
  const [st, setSt] = useState<Statement | null>(null);
  const [failed, setFailed] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const money = (cents: number) => formatMoney(cents, { currency, locale });
  const day = (iso: string) => formatDate(iso, { locale, dateStyle: "medium", timeStyle: undefined });

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      setFailed(false);
      try {
        const response = await fetch(`/api/operator/billing-customers/${customer.id}/credit`, { signal: controller.signal });
        if (!response.ok) throw new Error("statement_failed");
        const data = (await response.json()) as Statement;
        if (!controller.signal.aborted) setSt(data);
      } catch { if (!controller.signal.aborted) setFailed(true); }
    })();
    return () => controller.abort();
  }, [customer.id, revision]);

  async function reverse(abono: Abono) {
    if (!window.confirm(t("stReverseConfirm", { amount: money(abono.amountCents) }))) return;
    setBusyId(abono.id); setNotice("");
    try {
      const response = await fetch(`/api/operator/billing-customers/${customer.id}/credit-payments/${abono.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error("reverse_failed");
      setNotice(t("stReversed"));
      setRevision(n => n + 1);
      onChanged();
    } catch { setNotice(t("stReverseError")); }
    finally { setBusyId(null); }
  }

  const rows = st ? buildRows(st) : [];
  const TH = "px-2 py-1.5 text-left font-mono text-[10px] uppercase tracking-wider text-muted font-normal";
  const NUM = "px-2 py-1.5 text-right font-mono tabular whitespace-nowrap";
  return <div className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6" onClick={onClose}>
    <div role="dialog" aria-label={t("stTitle", { name: customer.customerName })} onClick={e => e.stopPropagation()} className="w-full md:max-w-2xl bg-paper rounded-t-3xl md:rounded-3xl border border-hairline p-5 space-y-4 max-h-[90dvh] overflow-y-auto">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-muted">{t("stDebt")}</div>
          <h2 className="font-display text-2xl mt-1">{st ? money(st.debtCents) : "…"}</h2>
          <p className="text-sm text-muted mt-1">{customer.customerName}</p>
        </div>
        <button type="button" onClick={onClose} className="text-muted text-sm shrink-0" aria-label={t("close")}>{"✕"}</button>
      </div>
      {notice && <p role="status" className="text-sm">{notice}</p>}
      {failed ? <p role="alert" className="text-sm text-danger">{t("stLoadError")}</p> : !st ? <p role="status" className="text-sm text-muted">{t("loading")}</p> : rows.length === 0 ? <p className="rounded-xl border border-dashed border-hairline p-5 text-sm text-muted">{t("stEmpty")}</p> : <div className="overflow-x-auto rounded-xl border border-hairline">
        <table className="w-full text-sm min-w-[520px]">
          <thead><tr className="border-b border-hairline bg-ivory">
            <th className={TH}>{t("stColDate")}</th><th className={TH}>{t("stColConcept")}</th>
            <th className={`${TH} text-right`}>{t("stColCharge")}</th><th className={`${TH} text-right`}>{t("stColPayment")}</th><th className={`${TH} text-right`}>{t("stColBalance")}</th>
          </tr></thead>
          <tbody>
            {rows.map(r => <tr key={r.key} className="border-b border-hairline/60 last:border-b-0 align-top">
              <td className="px-2 py-1.5 whitespace-nowrap">{day(r.date)}</td>
              {r.kind === "cargo" ? <td className="px-2 py-1.5 min-w-0">
                <span className="font-medium">{t("stCharge", { code: r.charge.orderShortCode })}</span>
                <span className="block text-xs text-muted">
                  {r.charge.tableLabel ? `${t("stChargeTable", { table: r.charge.tableLabel })} · ` : ""}
                  {r.charge.tipCents > 0 ? `${t("stTip", { amount: money(r.charge.tipCents) })} · ` : ""}
                  {r.charge.refundedCents > 0 ? `${t("stRefunded", { amount: money(r.charge.refundedCents) })} · ` : ""}
                  {r.charge.outstandingCents > 0 ? t("stOutstanding", { amount: money(r.charge.outstandingCents) }) : t("stPaid")}
                </span>
              </td> : <td className="px-2 py-1.5 min-w-0">
                <span className="font-medium">{t("stAbono")}</span>
                <span className="block text-xs text-muted">
                  {t("stAccount", { code: r.abono.accountCode })}
                  {r.abono.createdByName ? ` · ${t("stBy", { name: r.abono.createdByName })}` : ""}
                  {r.abono.note ? ` · ${r.abono.note}` : ""}
                </span>
                <button type="button" onClick={() => reverse(r.abono)} disabled={busyId !== null} className="mt-1 text-xs underline text-danger disabled:opacity-50">{t("stReverse")}</button>
              </td>}
              <td className={NUM}>{r.kind === "cargo" ? money(Math.max(0, r.charge.amountCents - r.charge.refundedCents)) : ""}</td>
              <td className={NUM}>{r.kind === "abono" ? money(r.abono.amountCents) : ""}</td>
              <td className={`${NUM} font-semibold`}>{money(r.balance)}</td>
            </tr>)}
          </tbody>
        </table>
      </div>}
    </div>
  </div>;
}
