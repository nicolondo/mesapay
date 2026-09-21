"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { formatDate, formatMoney } from "@/lib/format";
import type { Locale } from "@/i18n/config";
import { KindBadge, StatusBadge } from "../DiferidosClient";
import { ENTRY_PATH, LIST_PATH, monthLabel, type DeferredDetail } from "../shared";

const dtCls = "font-mono text-[9px] uppercase tracking-wider text-op-muted mb-1";
const thCls =
  "px-3 py-1.5 text-left font-mono text-[9px] uppercase tracking-wider font-normal text-op-muted";

/**
 * Detalle del diferido. "Dar de baja" pide confirmación explicando que el
 * saldo queda en la cuenta puente (no hay asiento de baja ni edición). La
 * proyección marca cada mes: contabilizado (existe el asiento `deferred`
 * del mes o el mes está cerrado), pendiente o cancelado por la baja.
 */
export function DiferidoDetailClient({ id, currency }: { id: string; currency: string }) {
  const t = useTranslations("opDiferidos");
  const locale = useLocale() as Locale;
  const [detail, setDetail] = useState<DeferredDetail | null | "missing">(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch(`/api/operator/accounting/deferred/${id}`);
    if (r.status === 404) return "missing" as const;
    if (!r.ok) throw new Error("load");
    return (await r.json()) as DeferredDetail;
  }, [id]);

  useEffect(() => {
    let alive = true;
    load()
      .then((d) => {
        if (alive) setDetail(d);
      })
      .catch(() => {
        if (alive) setErr("err_generic");
      });
    return () => {
      alive = false;
    };
  }, [load]);

  const money = (c: number) => formatMoney(c, { currency, locale });
  const errText = (code: string) => (t.has(code) ? t(code) : t("err_generic"));

  async function doClose() {
    if (detail === null || detail === "missing") return;
    if (!window.confirm(t("closeConfirm", { name: detail.item.name }))) return;
    setBusy(true);
    setErr(null);
    const r = await fetch(`/api/operator/accounting/deferred/${id}/close`, { method: "POST" });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setErr(`err_${j.error ?? "generic"}`);
      setBusy(false);
      return;
    }
    try {
      setDetail(await load());
    } catch {
      setErr("err_generic");
    }
    setBusy(false);
  }

  if (detail === "missing") {
    return (
      <div className="space-y-4">
        <p className="text-sm text-op-muted">{t("notFound")}</p>
        <Link href={LIST_PATH} className="text-sm text-op-accent hover:underline">
          {t("backToList")}
        </Link>
      </div>
    );
  }
  if (detail === null) {
    return <div className="text-sm text-op-muted">{err ? errText(err) : t("loading")}</div>;
  }

  const { item, initialEntryId, schedule } = detail;
  const closed = item.status === "closed";
  const closedDate = item.closedAt
    ? formatDate(item.closedAt, { locale, dateStyle: "long", timeStyle: undefined })
    : "";

  const field = (label: string, value: React.ReactNode, className = "") => (
    <div className={className}>
      <dt className={dtCls}>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href={LIST_PATH} className="text-xs text-op-muted hover:text-op-accent hover:underline">
            {t("backToList")}
          </Link>
          <div className="font-display text-3xl mt-1">{item.name}</div>
          <div className="flex flex-wrap gap-2 mt-2">
            <KindBadge kind={item.kind} long />
            <StatusBadge status={item.status} />
          </div>
        </div>
        {!closed && (
          <button
            type="button"
            onClick={doClose}
            disabled={busy}
            className="mp-btn mp-btn--danger px-4 shrink-0"
          >
            {busy ? t("closing") : t("close")}
          </button>
        )}
      </div>

      {err && <div className="text-sm text-danger">{errText(err)}</div>}

      <div className="rounded-2xl border border-op-border bg-op-surface p-4">
        <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
          {field(t("detailTotal"), <span className="font-medium">{money(item.totalCents)}</span>)}
          {field(t("detailQuota"), money(item.monthlyCents))}
          {field(t("detailStart"), monthLabel(item.startMonth, locale))}
          {field(t("detailAmortized"), money(item.amortizedCents))}
          {field(t("detailBalance"), <span className="font-medium">{money(item.balanceCents)}</span>)}
          {field(t("detailMonths"), t("monthsOf", { posted: item.postedMonths, total: item.months }))}
          {field(
            t("detailInitialEntry"),
            initialEntryId ? (
              <Link href={`${ENTRY_PATH}/${initialEntryId}`} className="text-op-accent hover:underline">
                {t("viewEntry")}
              </Link>
            ) : (
              <span className="text-op-muted">{"—"}</span>
            ),
          )}
          {item.costCenterName && field(t("detailCostCenter"), item.costCenterName)}
          {item.notes && field(t("detailNotes"), <span className="text-op-muted">{item.notes}</span>, "col-span-2 sm:col-span-3")}
        </dl>
        {closed && <p className="mt-3 text-xs text-op-muted">{t("closedNote", { date: closedDate })}</p>}
      </div>

      <div className="rounded-2xl border border-op-border bg-op-surface p-4">
        <div className="text-sm font-medium mb-2">{t("accountsTitle")}</div>
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
          {field(t("accSource"), `${item.sourceAccountCode} · ${item.sourceAccountName}`)}
          {field(t("accDeferral"), `${item.deferralAccountCode} · ${item.deferralAccountName}`)}
          {field(t("accTarget"), `${item.targetAccountCode} · ${item.targetAccountName}`)}
        </dl>
      </div>

      <div className="rounded-2xl border border-op-border bg-op-surface overflow-hidden">
        <div className="border-b border-op-border bg-op-bg px-4 py-2">
          <div className="text-sm font-medium">{t("scheduleTitle")}</div>
          <p className="text-xs text-op-muted mt-0.5">{t("scheduleIntro")}</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className={thCls + " pl-4"}>{t("colPeriod")}</th>
                <th className={thCls + " text-right"}>{t("colAmount")}</th>
                <th className={thCls + " pr-4"}>{t("colPosted")}</th>
              </tr>
            </thead>
            <tbody>
              {schedule.map((row) => (
                <tr
                  key={row.month}
                  className={"border-t border-op-border/60" + (row.cancelled ? " text-op-muted" : "")}
                >
                  <td className="px-3 py-1.5 pl-4">{monthLabel(row.month, locale)}</td>
                  <td
                    className={
                      "px-3 py-1.5 text-right font-mono tabular-nums" +
                      (row.cancelled ? " line-through" : "")
                    }
                  >
                    {money(row.amountCents)}
                  </td>
                  <td className="px-3 py-1.5 pr-4 text-xs">
                    {row.cancelled ? (
                      <span className="text-op-muted">{t("postedCancelled")}</span>
                    ) : row.posted ? (
                      <span className="text-ok">{t("postedYes")}</span>
                    ) : (
                      <span className="text-op-muted">{t("postedPending")}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
