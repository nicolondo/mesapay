"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { MoneyInput } from "@/components/MoneyInput";
import { formatMoney } from "@/lib/format";
import type { Locale } from "@/i18n/config";
import { fractionDigitsFor, majorToCents, todayYmd } from "../comprobantes/shared";
import { LIST_PATH, type DeferredItemDto, type DeferredListResponse } from "./shared";

type Kind = "expense" | "income";

const inputCls =
  "mt-1 w-full min-h-[44px] px-3 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-op-text/40";
const labelCls = "font-mono text-[10px] tracking-wider uppercase text-op-muted";
const thCls =
  "px-3 py-1.5 text-left font-mono text-[9px] uppercase tracking-wider font-normal text-op-muted";

/**
 * Lista de diferidos con progreso (amortizado / saldo / meses devengados) y
 * formulario de alta plegable. Las listas de cuenta puente y destino se
 * filtran en cliente según el tipo elegido (gasto: 17xx → 5/6; ingreso:
 * 27xx → 4). Los errores del servidor llegan por código (`err_<código>`).
 */
export function DiferidosClient({ currency }: { currency: string }) {
  const t = useTranslations("opDiferidos");
  const locale = useLocale() as Locale;
  const router = useRouter();
  const fractionDigits = fractionDigitsFor(currency);

  const [data, setData] = useState<DeferredListResponse | null>(null);
  const [loadErr, setLoadErr] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [kind, setKind] = useState<Kind>("expense");
  const [total, setTotal] = useState("");
  const [startDate, setStartDate] = useState(todayYmd());
  const [months, setMonths] = useState("12");
  const [sourceCode, setSourceCode] = useState("");
  const [deferralCode, setDeferralCode] = useState("");
  const [targetCode, setTargetCode] = useState("");
  const [costCenterId, setCostCenterId] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    let alive = true;
    fetch("/api/operator/accounting/deferred")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("load"))))
      .then((j) => {
        if (alive) setData(j as DeferredListResponse);
      })
      .catch(() => {
        if (alive) setLoadErr(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const money = (c: number) => formatMoney(c, { currency, locale });
  const errText = (code: string) => (t.has(code) ? t(code) : t("err_generic"));

  const deferralOptions =
    kind === "expense" ? (data?.accounts.deferralExpense ?? []) : (data?.accounts.deferralIncome ?? []);
  const targetOptions =
    kind === "expense" ? (data?.accounts.targetExpense ?? []) : (data?.accounts.targetIncome ?? []);
  const sourceOptions = data?.accounts.source ?? [];
  const centers = data?.centers ?? [];

  const totalCents = majorToCents(total);
  const monthsN = Number(months);
  const canSave =
    !saving &&
    name.trim().length >= 2 &&
    totalCents > 0 &&
    !!startDate &&
    Number.isInteger(monthsN) &&
    monthsN >= 1 &&
    !!sourceCode &&
    !!deferralCode &&
    !!targetCode;

  function changeKind(next: Kind) {
    setKind(next);
    setDeferralCode("");
    setTargetCode("");
  }

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setErr(null);
    const r = await fetch("/api/operator/accounting/deferred", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: name.trim(),
        kind,
        totalCents,
        startDate,
        months: monthsN,
        sourceAccountCode: sourceCode,
        deferralAccountCode: deferralCode,
        targetAccountCode: targetCode,
        costCenterId: costCenterId || null,
        notes: notes.trim() || null,
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      setErr(`err_${j.error ?? "generic"}`);
      setSaving(false);
      return;
    }
    router.push(`${LIST_PATH}/${j.id}`);
  }

  const accountSelect = (
    id: string,
    label: string,
    value: string,
    onChange: (v: string) => void,
    options: Array<{ code: string; name: string }>,
  ) => (
    <label className="block" htmlFor={id}>
      <span className={labelCls}>{label}</span>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} required className={inputCls}>
        <option value="">{t("pickAccount")}</option>
        {options.map((a) => (
          <option key={a.code} value={a.code}>
            {`${a.code} · ${a.name}`}
          </option>
        ))}
      </select>
      {options.length === 0 && <span className="block mt-1 text-xs text-danger">{t("noAccounts")}</span>}
    </label>
  );

  return (
    <div className="space-y-4">
      {!formOpen ? (
        <button
          type="button"
          onClick={() => setFormOpen(true)}
          className="mp-btn mp-btn--primary px-4"
        >
          {t("newItem")}
        </button>
      ) : (
        <form onSubmit={submit} className="rounded-2xl border border-op-border bg-op-surface p-4 space-y-3">
          <div>
            <div className="text-sm font-medium">{t("formTitle")}</div>
            <p className="text-xs text-op-muted mt-0.5">{t("formIntro")}</p>
          </div>
          {err && <div className="text-sm text-danger">{errText(err)}</div>}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block sm:col-span-2" htmlFor="def-name">
              <span className={labelCls}>{t("fName")}</span>
              <input
                id="def-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("fNamePlaceholder")}
                maxLength={120}
                required
                className={inputCls}
              />
            </label>
            <label className="block" htmlFor="def-kind">
              <span className={labelCls}>{t("fKind")}</span>
              <select
                id="def-kind"
                value={kind}
                onChange={(e) => changeKind(e.target.value as Kind)}
                className={inputCls}
              >
                <option value="expense">{t("kindExpenseLong")}</option>
                <option value="income">{t("kindIncomeLong")}</option>
              </select>
            </label>
            <label className="block" htmlFor="def-total">
              <span className={labelCls}>{t("fTotal")}</span>
              <MoneyInput
                id="def-total"
                value={total}
                onChange={setTotal}
                fractionDigits={fractionDigits}
                ariaLabel={t("fTotal")}
                placeholder="0"
                className={inputCls + " text-right font-mono tabular-nums"}
              />
            </label>
            <label className="block" htmlFor="def-start">
              <span className={labelCls}>{t("fStartDate")}</span>
              <input
                id="def-start"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                required
                className={inputCls}
              />
            </label>
            <label className="block" htmlFor="def-months">
              <span className={labelCls}>{t("fMonths")}</span>
              <input
                id="def-months"
                inputMode="numeric"
                value={months}
                onChange={(e) => setMonths(e.target.value.replace(/\D/g, "").slice(0, 3))}
                required
                className={inputCls + " tabular-nums"}
              />
            </label>
            {accountSelect("def-source", t("fSourceAccount"), sourceCode, setSourceCode, sourceOptions)}
            {accountSelect(
              "def-deferral",
              kind === "expense" ? t("fDeferralAccountExpense") : t("fDeferralAccountIncome"),
              deferralCode,
              setDeferralCode,
              deferralOptions,
            )}
            {accountSelect(
              "def-target",
              kind === "expense" ? t("fTargetAccountExpense") : t("fTargetAccountIncome"),
              targetCode,
              setTargetCode,
              targetOptions,
            )}
            {centers.length > 0 && (
              <label className="block" htmlFor="def-cc">
                <span className={labelCls}>{t("fCostCenter")}</span>
                <select
                  id="def-cc"
                  value={costCenterId}
                  onChange={(e) => setCostCenterId(e.target.value)}
                  className={inputCls}
                >
                  <option value="">{t("noCostCenter")}</option>
                  {centers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="block sm:col-span-2" htmlFor="def-notes">
              <span className={labelCls}>{t("fNotes")}</span>
              <input
                id="def-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                maxLength={1000}
                className={inputCls}
              />
            </label>
          </div>

          <div className="flex gap-2">
            <button type="submit" disabled={!canSave} className="mp-btn mp-btn--primary flex-1">
              {saving ? t("saving") : t("save")}
            </button>
            <button
              type="button"
              onClick={() => {
                setFormOpen(false);
                setErr(null);
              }}
              className="mp-btn mp-btn--ghost px-4"
            >
              {t("cancel")}
            </button>
          </div>
        </form>
      )}

      {loadErr ? (
        <div className="text-sm text-danger">{t("error")}</div>
      ) : data === null ? (
        <div className="text-sm text-op-muted">{t("loading")}</div>
      ) : data.items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-op-border bg-op-surface/50 p-8 text-center">
          <p className="text-sm text-op-muted">{t("empty")}</p>
        </div>
      ) : (
        <div className="rounded-2xl border border-op-border bg-op-surface overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className={thCls + " pl-4"}>{t("colName")}</th>
                  <th className={thCls}>{t("colKind")}</th>
                  <th className={thCls + " text-right"}>{t("colTotal")}</th>
                  <th className={thCls + " text-right"}>{t("colAmortized")}</th>
                  <th className={thCls + " text-right"}>{t("colBalance")}</th>
                  <th className={thCls + " text-right"}>{t("colMonths")}</th>
                  <th className={thCls + " pr-4"}>{t("colStatus")}</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((it) => (
                  <DeferredRow key={it.id} item={it} money={money} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function DeferredRow({ item, money }: { item: DeferredItemDto; money: (c: number) => string }) {
  const t = useTranslations("opDiferidos");
  const closed = item.status === "closed";
  return (
    <tr className="border-t border-op-border/60">
      <td className="px-3 py-2 pl-4 min-w-[12rem]">
        <Link
          href={`${LIST_PATH}/${item.id}`}
          className={"font-medium hover:text-op-accent hover:underline" + (closed ? " text-op-muted" : "")}
        >
          {item.name}
        </Link>
      </td>
      <td className="px-3 py-2">
        <KindBadge kind={item.kind} />
      </td>
      <td className="px-3 py-2 text-right font-mono tabular-nums">{money(item.totalCents)}</td>
      <td className="px-3 py-2 text-right font-mono tabular-nums text-op-muted">{money(item.amortizedCents)}</td>
      <td className="px-3 py-2 text-right font-mono tabular-nums font-medium">{money(item.balanceCents)}</td>
      <td className="px-3 py-2 text-right font-mono tabular-nums text-op-muted">
        {t("monthsOf", { posted: item.postedMonths, total: item.months })}
      </td>
      <td className="px-3 py-2 pr-4">
        <StatusBadge status={item.status} />
      </td>
    </tr>
  );
}

export function KindBadge({ kind, long }: { kind: Kind; long?: boolean }) {
  const t = useTranslations("opDiferidos");
  const label = long
    ? kind === "expense"
      ? t("kindExpenseLong")
      : t("kindIncomeLong")
    : kind === "expense"
      ? t("kindExpense")
      : t("kindIncome");
  return (
    <span
      className={
        "px-2 h-5 inline-flex items-center rounded-full text-[10px] font-medium " +
        (kind === "expense" ? "bg-warn/10 text-warn" : "bg-op-accent/10 text-op-accent")
      }
    >
      {label}
    </span>
  );
}

export function StatusBadge({ status }: { status: "active" | "closed" }) {
  const t = useTranslations("opDiferidos");
  return status === "active" ? (
    <span className="px-2 h-5 inline-flex items-center rounded-full bg-ok/10 text-ok text-[10px] font-medium">
      {t("statusActive")}
    </span>
  ) : (
    <span className="px-2 h-5 inline-flex items-center rounded-full bg-paper text-op-muted text-[10px] font-medium">
      {t("statusClosed")}
    </span>
  );
}
