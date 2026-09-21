"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { formatDate, formatMoney } from "@/lib/format";
import { MoneyInput } from "@/components/MoneyInput";
import type { Locale } from "@/i18n/config";
import type { AccountOption, AssetDetail, AssetDto } from "@/lib/erp/activosQuery";
import { centsToMajor, fractionDigitsFor, majorToCents } from "./comprobantes/shared";
import { ENTRY_PATH, monthLabel } from "./diferidos/shared";

type ListResponse = { assets: AssetDto[]; accounts: { asset: AccountOption[]; expense: AccountOption[] } };

/** Lo que manda el formulario (alta y edición). */
type AssetFormValues = {
  name: string;
  code: string;
  purchaseDate: string;
  price: string;
  salvage: string;
  lifeMonths: string;
  assetAccountCode: string;
  depreciationAccountCode: string;
  expenseAccountCode: string;
  notes: string;
};

const EMPTY_FORM: AssetFormValues = {
  name: "",
  code: "",
  purchaseDate: "",
  price: "",
  salvage: "",
  lifeMonths: "60",
  assetAccountCode: "",
  depreciationAccountCode: "159205",
  expenseAccountCode: "516005",
  notes: "",
};

const inputCls =
  "mt-1 w-full min-h-[44px] px-3 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-op-text/40";
const labelCls = "font-mono text-[10px] tracking-wider uppercase text-op-muted";
const thCls =
  "px-3 py-1.5 text-left font-mono text-[9px] uppercase tracking-wider font-normal text-op-muted";
const dtCls = "font-mono text-[10px] tracking-wider uppercase text-op-muted";

function fromDto(a: AssetDto, fractionDigits: 0 | 2): AssetFormValues {
  return {
    name: a.name,
    code: a.code ?? "",
    purchaseDate: a.purchaseDate,
    price: centsToMajor(a.purchaseCents, fractionDigits),
    salvage: centsToMajor(a.salvageCents, fractionDigits),
    lifeMonths: String(a.usefulLifeMonths),
    assetAccountCode: a.assetAccountCode,
    depreciationAccountCode: a.depreciationAccountCode,
    expenseAccountCode: a.expenseAccountCode,
    notes: a.notes ?? "",
  };
}

function toBody(f: AssetFormValues) {
  return {
    name: f.name.trim(),
    code: f.code.trim() || null,
    purchaseDate: f.purchaseDate,
    purchaseCents: majorToCents(f.price),
    salvageCents: majorToCents(f.salvage || "0"),
    usefulLifeMonths: Number(f.lifeMonths),
    assetAccountCode: f.assetAccountCode,
    depreciationAccountCode: f.depreciationAccountCode,
    expenseAccountCode: f.expenseAccountCode,
    notes: f.notes.trim() || null,
  };
}

/**
 * Formulario de activo (alta y edición): datos, cuentas del activo (15xx),
 * de depreciación acumulada (15xx) y de gasto (5xxx), código y notas.
 */
function AssetForm({
  initial,
  accounts,
  busy,
  err,
  submitLabel,
  onSubmit,
  onCancel,
  currency,
}: {
  initial: AssetFormValues;
  accounts: ListResponse["accounts"];
  busy: boolean;
  err: string | null;
  submitLabel: string;
  onSubmit: (values: AssetFormValues) => void;
  onCancel: () => void;
  currency: string;
}) {
  const t = useTranslations("opErp");
  const fractionDigits = fractionDigitsFor(currency);
  const [f, setF] = useState<AssetFormValues>(initial);
  const set = (patch: Partial<AssetFormValues>) => setF((p) => ({ ...p, ...patch }));
  const errText = (code: string) =>
    t.has(`assetErr_${code}`) ? t(`assetErr_${code}`) : t("assetErr_invalid");
  const canSave =
    !busy &&
    f.name.trim().length >= 2 &&
    !!f.purchaseDate &&
    majorToCents(f.price) > 0 &&
    Number(f.lifeMonths) >= 1 &&
    !!f.assetAccountCode &&
    !!f.depreciationAccountCode &&
    !!f.expenseAccountCode;

  const accountSelect = (
    label: string,
    value: string,
    onChange: (v: string) => void,
    options: AccountOption[],
  ) => (
    <label className="block">
      <span className={labelCls}>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} required className={inputCls}>
        <option value="">{t("assetPickAccount")}</option>
        {options.map((a) => (
          <option key={a.code} value={a.code}>
            {`${a.code} · ${a.name}`}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <form
      onSubmit={(ev) => {
        ev.preventDefault();
        if (canSave) onSubmit(f);
      }}
      className="space-y-3"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block">
          <span className={labelCls}>{t("assetName")}</span>
          <input
            value={f.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder={t("assetNamePlaceholder")}
            className={inputCls}
          />
        </label>
        <label className="block">
          <span className={labelCls}>{t("assetCode")}</span>
          <input
            value={f.code}
            maxLength={20}
            onChange={(e) => set({ code: e.target.value })}
            placeholder={t("assetCodePlaceholder")}
            className={inputCls}
          />
        </label>
        <label className="block">
          <span className={labelCls}>{t("assetPurchaseDate")}</span>
          <input
            type="date"
            value={f.purchaseDate}
            onChange={(e) => set({ purchaseDate: e.target.value })}
            className={inputCls}
          />
        </label>
        <label className="block">
          <span className={labelCls}>{t("assetLifeMonths")}</span>
          <input
            inputMode="numeric"
            value={f.lifeMonths}
            onChange={(e) => set({ lifeMonths: e.target.value.replace(/\D/g, "") })}
            className={inputCls + " tabular"}
          />
        </label>
        <label className="block">
          <span className={labelCls}>{t("assetPrice")}</span>
          <MoneyInput
            value={f.price}
            onChange={(v) => set({ price: v })}
            fractionDigits={fractionDigits}
            ariaLabel={t("assetPrice")}
            placeholder="0"
            className={inputCls + " text-right"}
          />
        </label>
        <label className="block">
          <span className={labelCls}>{t("assetSalvage")}</span>
          <MoneyInput
            value={f.salvage}
            onChange={(v) => set({ salvage: v })}
            fractionDigits={fractionDigits}
            ariaLabel={t("assetSalvage")}
            placeholder="0"
            className={inputCls + " text-right"}
          />
        </label>
        {accountSelect(t("assetAccount"), f.assetAccountCode, (v) => set({ assetAccountCode: v }), accounts.asset)}
        {accountSelect(
          t("assetDepreciationAccount"),
          f.depreciationAccountCode,
          (v) => set({ depreciationAccountCode: v }),
          accounts.asset,
        )}
        {accountSelect(
          t("assetExpenseAccount"),
          f.expenseAccountCode,
          (v) => set({ expenseAccountCode: v }),
          accounts.expense,
        )}
        <label className="block sm:col-span-2">
          <span className={labelCls}>{t("assetNotes")}</span>
          <textarea
            value={f.notes}
            maxLength={1000}
            rows={2}
            onChange={(e) => set({ notes: e.target.value })}
            className={inputCls + " py-2"}
          />
        </label>
      </div>
      {err && <div className="text-sm text-danger">{errText(err)}</div>}
      <div className="flex gap-2">
        <button type="submit" disabled={!canSave} className="mp-btn mp-btn--primary flex-1">
          {busy ? t("saving") : submitLabel}
        </button>
        <button type="button" onClick={onCancel} className="mp-btn mp-btn--ghost px-4">
          {t("cancel")}
        </button>
      </div>
    </form>
  );
}

/** Tabla de cuotas (contabilizadas o proyectadas) con enlace al comprobante del mes si existe. */
function ScheduleTable({
  rows,
  emptyLabel,
  money,
  locale,
  withEntry,
}: {
  rows: AssetDetail["posted"];
  emptyLabel: string;
  money: (c: number) => string;
  locale: Locale;
  withEntry: boolean;
}) {
  const t = useTranslations("opErp");
  if (rows.length === 0) return <div className="px-4 py-3 text-sm text-op-muted">{emptyLabel}</div>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr>
            <th className={thCls + " pl-4"}>{t("assetColPeriod")}</th>
            <th className={thCls + " text-right"}>{t("assetColAmount")}</th>
            {withEntry && <th className={thCls + " pr-4"} />}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.month} className="border-t border-op-border/60">
              <td className="px-3 py-1.5 pl-4">{monthLabel(r.month, locale)}</td>
              <td className="px-3 py-1.5 text-right font-mono tabular-nums">{money(r.amountCents)}</td>
              {withEntry && (
                <td className="px-3 py-1.5 pr-4 text-right text-xs">
                  {r.entryId ? (
                    <Link href={`${ENTRY_PATH}/${r.entryId}`} className="text-op-accent hover:underline">
                      {t("assetViewEntry")}
                    </Link>
                  ) : (
                    <span className="text-op-muted">{"—"}</span>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Activos fijos: lista con depreciado / valor en libros / meses
 * contabilizados, alta con cuentas propias y detalle (sheet) con edición,
 * baja/reactivación, depreciaciones contabilizadas y proyección restante.
 * El asiento del mes lo genera el motor del Diario con las cuentas de cada
 * activo.
 */
export function ActivosTab({ currency }: { currency: string }) {
  const t = useTranslations("opErp");
  const tDeferred = useTranslations("opDiferidos");
  const locale = useLocale() as Locale;
  const fractionDigits = fractionDigitsFor(currency);
  const [data, setData] = useState<ListResponse | null>(null);
  const [loadErr, setLoadErr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AssetDetail | null>(null);
  const [editing, setEditing] = useState(false);

  async function load(): Promise<void> {
    const r = await fetch("/api/operator/accounting/activos");
    if (!r.ok) throw new Error("load");
    setData((await r.json()) as ListResponse);
  }
  async function loadDetail(id: string): Promise<void> {
    const r = await fetch(`/api/operator/accounting/activos/${id}`);
    if (!r.ok) throw new Error("load");
    setDetail((await r.json()) as AssetDetail);
  }

  useEffect(() => {
    let alive = true;
    fetch("/api/operator/accounting/activos")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("load"))))
      .then((j) => {
        if (alive) setData(j as ListResponse);
      })
      .catch(() => {
        if (alive) setLoadErr(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Abrir/cerrar el detalle resetea su estado acá (no en el efecto), que
  // sólo carga cuando hay un activo elegido.
  function openDetail(id: string) {
    setErr(null);
    setDetail(null);
    setEditing(false);
    setSelectedId(id);
  }
  function closeDetail() {
    setSelectedId(null);
    setDetail(null);
    setEditing(false);
  }

  useEffect(() => {
    if (!selectedId) return;
    let alive = true;
    fetch(`/api/operator/accounting/activos/${selectedId}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("load"))))
      .then((j) => {
        if (alive) setDetail(j as AssetDetail);
      })
      .catch(() => {
        if (alive) setErr("not_found");
      });
    return () => {
      alive = false;
    };
  }, [selectedId]);

  const money = (c: number) => formatMoney(c, { currency, locale });
  const errText = (code: string) =>
    t.has(`assetErr_${code}`) ? t(`assetErr_${code}`) : t("assetErr_invalid");

  async function create(values: AssetFormValues) {
    setBusy(true);
    setErr(null);
    const r = await fetch("/api/operator/accounting/activos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(toBody(values)),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      setErr(j.error ?? "invalid");
      setBusy(false);
      return;
    }
    setFormOpen(false);
    await load().catch(() => setLoadErr(true));
    setBusy(false);
  }

  async function saveEdit(values: AssetFormValues) {
    if (!selectedId) return;
    setBusy(true);
    setErr(null);
    const r = await fetch(`/api/operator/accounting/activos/${selectedId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(toBody(values)),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      setErr(j.error ?? "invalid");
      setBusy(false);
      return;
    }
    setEditing(false);
    await Promise.all([load(), loadDetail(selectedId)]).catch(() => setLoadErr(true));
    setBusy(false);
  }

  async function dispose(a: AssetDto) {
    if (a.active && !window.confirm(t("assetDisposeConfirm"))) return;
    setBusy(true);
    setErr(null);
    await fetch("/api/operator/accounting/activos", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assetId: a.id, action: a.active ? "dispose" : "reactivate" }),
    });
    await Promise.all([load(), selectedId ? loadDetail(selectedId) : Promise.resolve()]).catch(() =>
      setLoadErr(true),
    );
    setBusy(false);
  }

  const field = (label: string, value: React.ReactNode, className = "") => (
    <div className={className}>
      <dt className={dtCls}>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );

  const statusBadge = (a: AssetDto) => (
    <span className={"mp-chip text-[10px] " + (a.active ? "" : "opacity-60")}>
      {a.active ? t("assetStatusActive") : t("assetStatusDisposed")}
    </span>
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-xs text-op-muted">{t("assetsIntro")}</p>
        {/* Los diferidos son el hermano contable de los activos (un valor
            que se reparte en cuotas mensuales); viven en su propia página. */}
        <Link
          href="/operator/contabilidad/diferidos"
          className="text-xs font-medium text-op-accent hover:underline shrink-0"
        >
          {tDeferred("linkFromAssets")}
        </Link>
      </div>

      {!formOpen ? (
        <button
          type="button"
          onClick={() => {
            setErr(null);
            setFormOpen(true);
          }}
          disabled={data === null}
          className="mp-btn mp-btn--primary mp-btn--block"
        >
          {t("assetNew")}
        </button>
      ) : (
        data && (
          <div className="rounded-2xl border border-op-border bg-op-surface p-4">
            <AssetForm
              initial={{
                ...EMPTY_FORM,
                assetAccountCode: data.accounts.asset[0]?.code ?? "",
              }}
              accounts={data.accounts}
              busy={busy}
              err={selectedId ? null : err}
              submitLabel={t("assetCreate")}
              onSubmit={create}
              onCancel={() => setFormOpen(false)}
              currency={currency}
            />
          </div>
        )
      )}

      {loadErr ? (
        <div className="text-sm text-danger">{t("errLoadFailed")}</div>
      ) : data === null ? (
        <div className="text-sm text-op-muted">{t("loadingEllipsis")}</div>
      ) : data.assets.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-op-border bg-op-surface/50 p-8 text-center text-sm text-op-muted">
          {t("assetsEmpty")}
        </div>
      ) : (
        <div className="bg-op-surface border border-op-border rounded-2xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className={thCls + " pl-4"}>{t("assetColCode")}</th>
                  <th className={thCls}>{t("assetColName")}</th>
                  <th className={thCls + " text-right"}>{t("assetColPurchase")}</th>
                  <th className={thCls + " text-right"}>{t("assetColDepreciated")}</th>
                  <th className={thCls + " text-right"}>{t("assetColBook")}</th>
                  <th className={thCls}>{t("assetColLife")}</th>
                  <th className={thCls + " pr-4"}>{t("assetColStatus")}</th>
                </tr>
              </thead>
              <tbody>
                {data.assets.map((a) => (
                  <tr
                    key={a.id}
                    onClick={() => openDetail(a.id)}
                    className={
                      "border-t border-op-border/60 cursor-pointer hover:bg-op-bg" +
                      (a.active ? "" : " opacity-60")
                    }
                  >
                    <td className="px-3 py-2 pl-4 font-mono text-xs text-op-muted">{a.code ?? "—"}</td>
                    <td className="px-3 py-2 font-medium">{a.name}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{money(a.purchaseCents)}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{money(a.depreciatedCents)}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{money(a.bookValueCents)}</td>
                    <td className="px-3 py-2 text-xs text-op-muted whitespace-nowrap">
                      {t("assetLifeProgress", { posted: a.postedMonths, total: a.usefulLifeMonths })}
                    </td>
                    <td className="px-3 py-2 pr-4">{statusBadge(a)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Detalle (sheet) */}
      {selectedId && (
        <div
          className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
          onClick={closeDetail}
        >
          <div
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
            className="w-full md:max-w-2xl max-h-[92vh] overflow-y-auto rounded-t-2xl md:rounded-2xl bg-op-surface border border-op-border p-4 space-y-4"
          >
            {detail === null ? (
              <div className="text-sm text-op-muted">{err ? errText(err) : t("loadingEllipsis")}</div>
            ) : (
              <>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-display text-2xl truncate">{detail.asset.name}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-op-muted">
                      {detail.asset.code && <span className="font-mono">{detail.asset.code}</span>}
                      {statusBadge(detail.asset)}
                    </div>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    {!editing && (
                      <button
                        type="button"
                        onClick={() => {
                          setErr(null);
                          setEditing(true);
                        }}
                        disabled={busy}
                        className="mp-btn mp-btn--secondary mp-btn--sm px-3"
                      >
                        {t("edit")}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => dispose(detail.asset)}
                      disabled={busy}
                      className={
                        "mp-btn mp-btn--sm px-3 " + (detail.asset.active ? "mp-btn--danger" : "mp-btn--secondary")
                      }
                    >
                      {detail.asset.active ? t("assetDispose") : t("assetReactivate")}
                    </button>
                    <button
                      type="button"
                      onClick={closeDetail}
                      className="mp-btn mp-btn--ghost mp-btn--sm px-3"
                    >
                      {t("assetCloseDetail")}
                    </button>
                  </div>
                </div>

                {editing ? (
                  <div className="rounded-2xl border border-op-border bg-op-bg/40 p-4 space-y-3">
                    <p className="text-xs text-op-muted">{t("assetEditNote")}</p>
                    <AssetForm
                      initial={fromDto(detail.asset, fractionDigits)}
                      accounts={data?.accounts ?? { asset: [], expense: [] }}
                      busy={busy}
                      err={err}
                      submitLabel={t("save")}
                      onSubmit={saveEdit}
                      onCancel={() => {
                        setErr(null);
                        setEditing(false);
                      }}
                      currency={currency}
                    />
                  </div>
                ) : (
                  <>
                    <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
                      {field(t("assetPrice"), <span className="font-medium">{money(detail.asset.purchaseCents)}</span>)}
                      {field(t("assetSalvage"), money(detail.asset.salvageCents))}
                      {field(t("assetDetailQuota"), money(detail.asset.monthlyCents))}
                      {field(t("assetDetailDepreciated"), money(detail.asset.depreciatedCents))}
                      {field(
                        t("assetDetailBook"),
                        <span className="font-medium">{money(detail.asset.bookValueCents)}</span>,
                      )}
                      {field(
                        t("assetDetailLife"),
                        t("assetLifeProgress", {
                          posted: detail.asset.postedMonths,
                          total: detail.asset.usefulLifeMonths,
                        }),
                      )}
                      {field(
                        t("assetPurchaseDate"),
                        formatDate(`${detail.asset.purchaseDate}T12:00:00.000Z`, {
                          locale,
                          timeZone: "UTC",
                        }),
                      )}
                      {field(t("assetDetailStart"), monthLabel(detail.asset.startMonth, locale))}
                      {detail.asset.disposedAt &&
                        field(
                          t("assetColStatus"),
                          t("assetDetailDisposed", {
                            date: formatDate(detail.asset.disposedAt, { locale }),
                          }),
                        )}
                      {field(t("assetAccount"), `${detail.asset.assetAccountCode} · ${detail.asset.assetAccountName}`)}
                      {field(
                        t("assetDepreciationAccount"),
                        `${detail.asset.depreciationAccountCode} · ${detail.asset.depreciationAccountName}`,
                      )}
                      {field(
                        t("assetExpenseAccount"),
                        `${detail.asset.expenseAccountCode} · ${detail.asset.expenseAccountName}`,
                      )}
                      {detail.asset.notes &&
                        field(
                          t("assetNotes"),
                          <span className="text-op-muted whitespace-pre-wrap">{detail.asset.notes}</span>,
                          "col-span-2 sm:col-span-3",
                        )}
                    </dl>
                    {err && <div className="text-sm text-danger">{errText(err)}</div>}
                  </>
                )}

                <div className="rounded-2xl border border-op-border overflow-hidden">
                  <div className="border-b border-op-border bg-op-bg px-4 py-2">
                    <div className="text-sm font-medium">{t("assetPostedTitle")}</div>
                    <p className="text-xs text-op-muted mt-0.5">{t("assetPostedIntro")}</p>
                  </div>
                  <ScheduleTable
                    rows={detail.posted}
                    emptyLabel={t("assetNoPosted")}
                    money={money}
                    locale={locale}
                    withEntry
                  />
                </div>

                <div className="rounded-2xl border border-op-border overflow-hidden">
                  <div className="border-b border-op-border bg-op-bg px-4 py-2 text-sm font-medium">
                    {t("assetProjectedTitle")}
                  </div>
                  <ScheduleTable
                    rows={detail.projected}
                    emptyLabel={t("assetNoProjected")}
                    money={money}
                    locale={locale}
                    withEntry={false}
                  />
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
