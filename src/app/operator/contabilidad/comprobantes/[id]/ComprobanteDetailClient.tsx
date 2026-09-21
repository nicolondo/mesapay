"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { formatDate, formatMoney } from "@/lib/format";
import type { Locale } from "@/i18n/config";
import { LIST_PATH, voucherLabel, type EntryDetail } from "../shared";

const thCls =
  "px-3 py-1.5 text-left font-mono text-[9px] uppercase tracking-wider font-normal text-op-muted";

/**
 * Detalle del comprobante. Las acciones salen de canEdit/canDelete/
 * canReverse que calcula el servidor (manual + mes abierto para editar o
 * borrar; mes cerrado o manual para reversar). Reversar crea OTRO
 * comprobante y navega a él; el original queda marcado como anulado.
 */
export function ComprobanteDetailClient({ id, currency }: { id: string; currency: string }) {
  const t = useTranslations("opComprobantes");
  const tErp = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const router = useRouter();
  const [entry, setEntry] = useState<EntryDetail | null | "missing">(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(`/api/operator/accounting/entries/${id}`)
      .then(async (r) => {
        if (r.status === 404) return "missing" as const;
        if (!r.ok) throw new Error("load");
        return (await r.json()).entry as EntryDetail;
      })
      .then((e) => {
        if (alive) setEntry(e);
      })
      .catch(() => {
        if (alive) setErr("err_generic");
      });
    return () => {
      alive = false;
    };
  }, [id]);

  const money = (c: number) => formatMoney(c, { currency, locale });
  const sourceLabel = (source: string) =>
    source === "manual"
      ? t("jSource_manual")
      : tErp.has(`jSource_${source}`)
        ? tErp(`jSource_${source}`)
        : source;
  const errText = (code: string) => (t.has(code) ? t(code) : t("err_generic"));

  async function doDelete() {
    if (!window.confirm(t("deleteConfirm"))) return;
    setBusy(true);
    setErr(null);
    const r = await fetch(`/api/operator/accounting/entries/${id}`, { method: "DELETE" });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setErr(`err_${j.error ?? "generic"}`);
      setBusy(false);
      return;
    }
    router.push(LIST_PATH);
  }

  async function doReverse() {
    if (!window.confirm(t("reverseConfirm"))) return;
    setBusy(true);
    setErr(null);
    const r = await fetch(`/api/operator/accounting/entries/${id}/reverse`, { method: "POST" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      setErr(`err_${j.error ?? "generic"}`);
      setBusy(false);
      return;
    }
    router.push(`${LIST_PATH}/${j.entry.id}`);
  }

  if (entry === "missing") {
    return (
      <div className="space-y-4">
        <p className="text-sm text-op-muted">{t("notFound")}</p>
        <Link href={LIST_PATH} className="text-sm text-op-accent hover:underline">
          {t("backToList")}
        </Link>
      </div>
    );
  }
  if (entry === null) {
    return (
      <div className="text-sm text-op-muted">{err ? errText(err) : t("loading")}</div>
    );
  }

  const annulled = entry.status === "annulled" || entry.annulledAt != null;
  const title =
    entry.voucherNumber != null
      ? t("detailTitle", { n: voucherLabel(entry.voucherNumber) })
      : t("detailTitleUnnumbered");
  const longDate = formatDate(entry.date, {
    locale,
    timeZone: "UTC",
    dateStyle: "long",
    timeStyle: undefined,
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href={LIST_PATH} className="text-xs text-op-muted hover:text-op-accent hover:underline">
            {t("backToList")}
          </Link>
          <div className="font-display text-3xl mt-1">{title}</div>
          {entry.memo && (
            <p className={"text-sm mt-1 " + (annulled ? "line-through text-op-muted" : "")}>
              {entry.memo}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2 shrink-0">
          {entry.canEdit && (
            <Link href={`${LIST_PATH}/${entry.id}/editar`} className="mp-btn mp-btn--secondary px-4">
              {t("edit")}
            </Link>
          )}
          {entry.canReverse && (
            <button
              type="button"
              onClick={doReverse}
              disabled={busy}
              className="mp-btn mp-btn--ghost px-4"
            >
              {busy ? t("working") : t("reverse")}
            </button>
          )}
          {entry.canDelete && (
            <button
              type="button"
              onClick={doDelete}
              disabled={busy}
              className="mp-btn mp-btn--danger px-4"
            >
              {busy ? t("working") : t("delete")}
            </button>
          )}
        </div>
      </div>

      {err && <div className="text-sm text-danger">{errText(err)}</div>}

      <div className="rounded-2xl border border-op-border bg-op-surface p-4">
        <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <div>
            <dt className="font-mono text-[9px] uppercase tracking-wider text-op-muted mb-1">
              {t("fDate")}
            </dt>
            <dd className="tabular-nums">{longDate}</dd>
          </div>
          <div>
            <dt className="font-mono text-[9px] uppercase tracking-wider text-op-muted mb-1">
              {t("fSource")}
            </dt>
            <dd>
              <span className="px-2 h-5 inline-flex items-center rounded-full bg-paper text-op-muted text-[10px] font-medium">
                {sourceLabel(entry.source)}
              </span>
            </dd>
          </div>
          <div>
            <dt className="font-mono text-[9px] uppercase tracking-wider text-op-muted mb-1">
              {t("fThirdParty")}
            </dt>
            <dd className="min-w-0">
              {entry.thirdPartyName ? (
                <>
                  <span className="block truncate">{entry.thirdPartyName}</span>
                  {entry.thirdPartyTaxId && (
                    <span className="block font-mono text-xs text-op-muted">
                      {entry.thirdPartyTaxId}
                    </span>
                  )}
                </>
              ) : (
                <span className="text-op-muted">{"—"}</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="font-mono text-[9px] uppercase tracking-wider text-op-muted mb-1">
              {t("fStatus")}
            </dt>
            <dd>
              {annulled ? (
                <span className="px-2 h-5 inline-flex items-center rounded-full bg-danger/10 text-danger text-[10px] font-medium">
                  {t("statusAnnulled")}
                </span>
              ) : (
                <span className="px-2 h-5 inline-flex items-center rounded-full bg-ok/10 text-ok text-[10px] font-medium">
                  {t("statusPosted")}
                </span>
              )}
            </dd>
          </div>
        </dl>
        {(entry.reversalOfId || entry.reversedBy) && (
          <div className="mt-3 pt-3 border-t border-op-border/60 text-sm space-y-1">
            {entry.reversalOfId &&
              (entry.reversalOf ? (
                <Link
                  href={`${LIST_PATH}/${entry.reversalOf.id}`}
                  className="text-op-accent hover:underline"
                >
                  {entry.reversalOf.voucherNumber != null
                    ? t("reversalOf", { n: voucherLabel(entry.reversalOf.voucherNumber) })
                    : t("reversalOfUnnumbered")}
                </Link>
              ) : (
                <span className="text-op-muted">{t("reversalOfUnnumbered")}</span>
              ))}
            {entry.reversedBy && (
              <Link
                href={`${LIST_PATH}/${entry.reversedBy.id}`}
                className="block text-op-accent hover:underline"
              >
                {entry.reversedBy.voucherNumber != null
                  ? t("reversedBy", { n: voucherLabel(entry.reversedBy.voucherNumber) })
                  : t("reversedByUnnumbered")}
              </Link>
            )}
          </div>
        )}
        {entry.monthClosed && !annulled && (
          <p className="mt-3 text-xs text-op-muted">{t("monthClosedNote")}</p>
        )}
        {!entry.monthClosed && entry.source !== "manual" && !annulled && (
          <p className="mt-3 text-xs text-op-muted">{t("autoOpenNote")}</p>
        )}
      </div>

      <div className="rounded-2xl border border-op-border bg-op-surface overflow-hidden">
        <div className="border-b border-op-border bg-op-bg px-4 py-2 text-sm font-medium">
          {t("linesTitle")}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className={thCls + " pl-4"}>{t("lAccount")}</th>
                <th className={thCls}>{t("lCenter")}</th>
                <th className={thCls}>{t("lMemo")}</th>
                <th className={thCls + " text-right"}>{t("lDebit")}</th>
                <th className={thCls + " text-right pr-4"}>{t("lCredit")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-op-border/50">
              {entry.lines.map((l) => (
                <tr key={l.id}>
                  <td className="px-3 py-1.5 pl-4 min-w-0">
                    <span className="font-mono text-xs text-op-muted tabular-nums mr-2">
                      {l.accountCode}
                    </span>
                    {l.accountName}
                  </td>
                  <td className="px-3 py-1.5 text-op-muted whitespace-nowrap">
                    {l.costCenterName ?? "—"}
                  </td>
                  <td className="px-3 py-1.5 text-op-muted min-w-0 max-w-[16rem] truncate">
                    {l.memo ?? ""}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums whitespace-nowrap">
                    {l.debitCents ? money(l.debitCents) : "—"}
                  </td>
                  <td className="px-3 py-1.5 pr-4 text-right font-mono tabular-nums whitespace-nowrap">
                    {l.creditCents ? money(l.creditCents) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-baseline justify-end gap-x-6 gap-y-1 border-t border-op-border bg-op-bg px-4 py-2 text-sm">
          <span className="font-medium">
            {t("totalsDebits")}
            {": "}
            <span className="font-mono tabular-nums">{money(entry.totalDebitCents)}</span>
          </span>
          <span className="font-medium">
            {t("totalsCredits")}
            {": "}
            <span className="font-mono tabular-nums">{money(entry.totalCreditCents)}</span>
          </span>
          {entry.balanced ? (
            <span className="px-2 h-5 inline-flex items-center rounded-full bg-ok/10 text-ok text-[10px] font-medium">
              {t("balancedOk")}
            </span>
          ) : (
            <span className="px-2 h-5 inline-flex items-center rounded-full bg-danger/10 text-danger text-[10px] font-medium">
              {t("unbalanced")}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
