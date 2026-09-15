"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { formatDate, formatMoney } from "@/lib/format";
import type { Locale } from "@/i18n/config";
import { useApiError } from "@/lib/useApiError";

export type ReportRowClient = {
  id: string;
  redeemedAt: string;
  code: string;
  orderId: string;
  orderCode: string;
  amountCents: number;
  voucherBalanceCents: number;
  mode: "prepaid" | "credit";
  channel: "diner" | "staff";
  customerId: string;
  customerName: string;
  statementId: string | null;
};

export type StatementRow = {
  id: string;
  createdAt: string;
  periodFrom: string;
  periodTo: string;
  totalCents: number;
  creditCents: number;
  redemptionCount: number;
  status: "open" | "paid";
  emailSentAt: string | null;
  customerName: string;
};

const inputCls =
  "h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-op-text/40";
const labelCls = "block font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1";

export function ReporteClient({
  currency,
  customers,
  filter,
  rows,
  statements,
}: {
  currency: string;
  customers: { id: string; customerName: string }[];
  filter: { customer: string | null; from: string; to: string };
  rows: ReportRowClient[];
  statements: StatementRow[];
}) {
  const t = useTranslations("opVouchers");
  const locale = useLocale() as Locale;
  const router = useRouter();
  const apiError = useApiError();
  const money = (cents: number) => formatMoney(cents, { currency, locale });
  const day = (iso: string) => formatDate(iso, { locale, dateStyle: "medium", timeStyle: undefined });

  const [customer, setCustomer] = useState(filter.customer ?? "");
  const [from, setFrom] = useState(filter.from);
  const [to, setTo] = useState(filter.to);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const codeText = (j: { error?: unknown }, fallback: string) =>
    typeof j.error === "string" && t.has(j.error) ? t(j.error) : apiError(j, fallback);

  const query = new URLSearchParams({
    ...(customer ? { customer } : {}),
    from,
    to,
  }).toString();

  const totalCents = rows.reduce((s, r) => s + r.amountCents, 0);
  const creditCents = rows.filter((r) => r.mode === "credit").reduce((s, r) => s + r.amountCents, 0);
  const pendingRows = rows.filter((r) => !r.statementId);
  const pendingCents = pendingRows.reduce((s, r) => s + r.amountCents, 0);
  const canClose = !!filter.customer && pendingRows.length > 0 && busy === null;
  const selectedName = customers.find((c) => c.id === filter.customer)?.customerName ?? "";

  function applyFilter() {
    router.push(`/operator/bonos/reporte?${query}`);
  }

  async function closeStatement() {
    if (!filter.customer) return;
    if (
      !confirm(
        t("closeStatementConfirm", {
          customer: selectedName,
          count: pendingRows.length,
          total: money(pendingCents),
        }),
      )
    )
      return;
    setBusy("close");
    setMsg(null);
    try {
      const r = await fetch("/api/operator/vouchers/statements", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ billingCustomerId: filter.customer, from: filter.from, to: filter.to }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setMsg({ kind: "error", text: codeText(j, t("actionError")) });
        return;
      }
      setMsg({
        kind: "ok",
        text: j.emailed
          ? t("closedOk", { count: j.statement.count, total: money(j.statement.totalCents) })
          : t("closedNoEmail", { count: j.statement.count, total: money(j.statement.totalCents) }),
      });
      router.refresh();
    } catch {
      setMsg({ kind: "error", text: t("actionError") });
    } finally {
      setBusy(null);
    }
  }

  async function resend(id: string) {
    setBusy(id);
    setMsg(null);
    try {
      const r = await fetch(`/api/operator/vouchers/statements/${id}/resend-email`, { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setMsg({ kind: "error", text: codeText(j, t("resendError")) });
        return;
      }
      setMsg({ kind: "ok", text: t("resent") });
      router.refresh();
    } catch {
      setMsg({ kind: "error", text: t("resendError") });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-8">
      <section className="rounded-2xl border border-op-border bg-op-surface p-5 space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className={labelCls}>{t("filterCustomer")}</span>
            <select
              value={customer}
              onChange={(e) => setCustomer(e.target.value)}
              className={inputCls + " min-w-[220px]"}
            >
              <option value="">{t("filterAllCustomers")}</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.customerName}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={labelCls}>{t("filterFrom")}</span>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inputCls} />
          </label>
          <label className="block">
            <span className={labelCls}>{t("filterTo")}</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={inputCls} />
          </label>
          <button type="button" onClick={applyFilter} className="mp-btn mp-btn--secondary">
            {t("applyFilter")}
          </button>
          <a
            href={`/api/operator/vouchers/report/export?${new URLSearchParams({
              ...(filter.customer ? { customer: filter.customer } : {}),
              from: filter.from,
              to: filter.to,
            }).toString()}`}
            className="mp-btn mp-btn--ghost ml-auto"
          >
            {t("exportCsv")}
          </a>
        </div>
        <Link href="/operator/bonos" className="text-xs text-terracotta underline">
          {t("backToList")}
        </Link>
      </section>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label={t("totalRedemptions")} value={String(rows.length)} />
        <Stat label={t("totalRedeemed")} value={money(totalCents)} />
        <Stat label={t("totalCredit")} value={money(creditCents)} />
        <Stat label={t("totalPending")} value={money(pendingCents)} hint={t("totalPendingHint", { count: pendingRows.length })} />
      </section>

      <section className="rounded-2xl border border-op-border bg-op-surface p-5 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="text-sm">
            {filter.customer
              ? t("closeHint", { customer: selectedName, count: pendingRows.length, total: money(pendingCents) })
              : t("closeNeedsCustomer")}
          </div>
          <button
            type="button"
            disabled={!canClose}
            onClick={closeStatement}
            className="mp-btn mp-btn--primary ml-auto"
          >
            {busy === "close" ? t("closing") : t("closeStatement")}
          </button>
        </div>
        {msg && (
          <p role="status" className={"text-xs " + (msg.kind === "ok" ? "text-ok" : "text-danger")}>
            {msg.text}
          </p>
        )}
      </section>

      <section>
        <h2 className="font-display text-xl mb-3">{t("redemptionsTitle")}</h2>
        {rows.length === 0 ? (
          <div className="mp-empty-state">
            <h2>{t("noRedemptions")}</h2>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-op-border bg-op-surface">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left font-mono text-[10px] tracking-[0.12em] uppercase text-op-muted">
                  <th className="px-4 py-3">{t("colDate")}</th>
                  <th className="px-4 py-3">{t("colCustomer")}</th>
                  <th className="px-4 py-3">{t("colCode")}</th>
                  <th className="px-4 py-3">{t("colOrder")}</th>
                  <th className="px-4 py-3 text-right">{t("colAmount")}</th>
                  <th className="px-4 py-3 text-right">{t("colVoucherBalance")}</th>
                  <th className="px-4 py-3">{t("colMode")}</th>
                  <th className="px-4 py-3">{t("colChannel")}</th>
                  <th className="px-4 py-3">{t("colStatement")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-op-border">
                    <td className="px-4 py-3 whitespace-nowrap">
                      {formatDate(r.redeemedAt, { locale, dateStyle: "medium", timeStyle: "short" })}
                    </td>
                    <td className="px-4 py-3">{r.customerName}</td>
                    <td className="px-4 py-3 font-mono tracking-[0.06em]">{r.code}</td>
                    <td className="px-4 py-3">
                      <Link href={`/operator/orders/${r.orderId}`} className="text-terracotta underline">
                        {r.orderCode}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{money(r.amountCents)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{money(r.voucherBalanceCents)}</td>
                    <td className="px-4 py-3">{r.mode === "prepaid" ? t("modePrepaid") : t("modeCredit")}</td>
                    <td className="px-4 py-3">{t(`channel_${r.channel}`)}</td>
                    <td className="px-4 py-3">
                      {r.statementId ? (
                        <span className="inline-block rounded-full px-2 py-0.5 text-[11px] font-medium bg-ok/15 text-ok">
                          {t("inStatement")}
                        </span>
                      ) : (
                        <span className="inline-block rounded-full px-2 py-0.5 text-[11px] font-medium bg-[#C98A2E]/20 text-[#8F6828]">
                          {t("notCut")}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="font-display text-xl mb-3">{t("statementsTitle")}</h2>
        {statements.length === 0 ? (
          <p className="text-sm text-op-muted">{t("noStatements")}</p>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-op-border bg-op-surface">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left font-mono text-[10px] tracking-[0.12em] uppercase text-op-muted">
                  <th className="px-4 py-3">{t("stColClosed")}</th>
                  <th className="px-4 py-3">{t("colCustomer")}</th>
                  <th className="px-4 py-3">{t("stColPeriod")}</th>
                  <th className="px-4 py-3 text-right">{t("stColCount")}</th>
                  <th className="px-4 py-3 text-right">{t("colTotal")}</th>
                  <th className="px-4 py-3 text-right">{t("stColCredit")}</th>
                  <th className="px-4 py-3">{t("colStatus")}</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {statements.map((s) => (
                  <tr key={s.id} className="border-t border-op-border">
                    <td className="px-4 py-3 whitespace-nowrap">{day(s.createdAt)}</td>
                    <td className="px-4 py-3">{s.customerName}</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {t("periodRange", { from: day(s.periodFrom), to: day(s.periodTo) })}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{s.redemptionCount}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{money(s.totalCents)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{money(s.creditCents)}</td>
                    <td className="px-4 py-3">
                      <span
                        className={
                          "inline-block rounded-full px-2 py-0.5 text-[11px] font-medium " +
                          (s.status === "paid" ? "bg-ok/15 text-ok" : "bg-[#C98A2E]/20 text-[#8F6828]")
                        }
                      >
                        {s.status === "paid" ? t("stStatus_paid") : t("stStatus_open")}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <span className="text-xs text-op-muted mr-2">
                        {s.emailSentAt ? t("emailSentShort", { date: day(s.emailSentAt) }) : t("emailNotSent")}
                      </span>
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => resend(s.id)}
                        className="text-xs text-terracotta underline"
                      >
                        {busy === s.id ? t("resending") : t("resend")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-op-border bg-op-surface p-4">
      <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">{label}</div>
      <div className="font-display text-2xl tabular-nums mt-1">{value}</div>
      {hint && <div className="text-xs text-op-muted mt-1">{hint}</div>}
    </div>
  );
}
