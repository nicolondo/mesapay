"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatDate, formatMoney } from "@/lib/format";
import { MoneyInput } from "@/components/MoneyInput";
import { formatBaseQty, type MeasureKind } from "@/lib/erp/units";
import { isSupplierCreditNoteKind } from "@/lib/erp/supplierCreditNotes";
import {
  payableKey,
  planCreditAllocation,
  previewAllocation,
  sortPayablesFifo,
  type PayableDocRef,
} from "@/lib/erp/supplierCreditAllocation";
import type { CreditNoteDetail as Detail } from "@/lib/erp/supplierCreditNoteQueries";
import { docLabel } from "./docLabel";
import { KindChip } from "./KindChip";

const ERROR_KEYS: Record<string, string> = {
  has_refunds: "errHasRefunds",
  applied_in_closed_month: "errAppliedClosed",
  month_closed: "errMonthClosed",
  already_voided: "errAlreadyVoided",
  voided: "errAlreadyVoided",
  exceeds_available: "errPlanTooMuch",
  exceeds_balance: "errPlanChanged",
  account_invalid: "errAccount",
  amount_invalid: "errInvalid",
};

const todayInput = () => {
  const d = new Date();
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/**
 * Detalle de una nota crédito: datos, a qué facturas se aplicó, reintegros
 * y saldo a favor. Acciones: aplicar el saldo a favor (FIFO, con vista
 * previa), registrar el reintegro en dinero y anular (con motivo).
 */
export function CreditNoteDetail({
  noteId,
  currency,
  onClose,
  onChanged,
}: {
  noteId: string;
  currency: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = useTranslations("opSupplierCredit");
  const locale = useLocale() as Locale;
  const money = (c: number) => formatMoney(c, { currency, locale, fractionDigits: "auto" });
  const date = (iso: string) => formatDate(iso, { locale, timeStyle: undefined });
  const [note, setNote] = useState<Detail | null>(null);
  const [loadErr, setLoadErr] = useState(false);
  const [reload, setReload] = useState(0);
  const [panel, setPanel] = useState<"apply" | "refund" | "void" | null>(null);
  const [payables, setPayables] = useState<PayableDocRef[] | null>(null);
  const [accounts, setAccounts] = useState<{ code: string; name: string }[]>([]);
  const [refund, setRefund] = useState({ amount: "", date: todayInput(), accountCode: "", note: "" });
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/operator/supplier-credit-notes/${encodeURIComponent(noteId)}`, { cache: "no-store" });
        if (!r.ok) throw new Error("load");
        const j = await r.json();
        if (!cancelled) setNote(j.note as Detail);
      } catch {
        if (!cancelled) setLoadErr(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [noteId, reload]);

  async function openApply() {
    if (!note) return;
    setPanel("apply");
    setErr(null);
    setPayables(null);
    try {
      const r = await fetch(`/api/operator/supplier-credit-notes/context?supplierId=${encodeURIComponent(note.supplier.id)}&invoices=0`);
      const j = await r.json();
      setPayables(sortPayablesFifo((j.payables ?? []) as PayableDocRef[]));
    } catch {
      setErr(t("errContext"));
    }
  }

  async function openRefund() {
    setPanel("refund");
    setErr(null);
    if (note) setRefund((r) => ({ ...r, amount: String(note.availableCents / 100) }));
    try {
      const r = await fetch("/api/operator/purchase-orders/payment-accounts");
      const j = await r.json();
      const list = (j.accounts ?? []) as { code: string; name: string }[];
      setAccounts(list);
      setRefund((prev) => ({ ...prev, accountCode: prev.accountCode || list[0]?.code || "" }));
    } catch {
      setErr(t("errContext"));
    }
  }

  async function act(url: string, body: unknown) {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => null);
      if (!r.ok) {
        setErr(t(ERROR_KEYS[j?.error as string] ?? "errSave"));
        return false;
      }
      setPanel(null);
      setReload((k) => k + 1);
      onChanged();
      return true;
    } catch {
      setErr(t("errSave"));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function deleteRefund(id: string) {
    if (!note || !window.confirm(t("confirmDeleteRefund"))) return;
    setBusy(true);
    setErr(null);
    const r = await fetch(`/api/operator/supplier-credit-notes/${encodeURIComponent(note.id)}/refunds/${encodeURIComponent(id)}`, { method: "DELETE" });
    setBusy(false);
    if (!r.ok) {
      const j = await r.json().catch(() => null);
      setErr(t(ERROR_KEYS[j?.error as string] ?? "errSave"));
      return;
    }
    setReload((k) => k + 1);
    onChanged();
  }

  const plan = note && payables ? planCreditAllocation(note.availableCents, payables) : [];
  const voided = note?.status === "voided";

  return (
    <div className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6" onClick={() => panel === null && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="credit-note-detail-title"
        className="w-full md:max-w-xl bg-op-surface rounded-t-3xl md:rounded-3xl border border-op-border p-5 max-h-[94dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 mb-1">
          <h2 id="credit-note-detail-title" className="font-display text-2xl min-w-0 truncate">
            {note ? t("detailTitle_note", { number: note.number }) : t("loading")}
          </h2>
          <button type="button" onClick={onClose} className="text-op-muted text-sm shrink-0 min-h-[44px] min-w-[44px] -mt-2 -mr-2" aria-label={t("close")}>
            {"✕"}
          </button>
        </div>
        {loadErr ? (
          <p className="text-xs text-danger">{t("errContext")}</p>
        ) : !note ? null : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-[12px] text-op-muted">
              {isSupplierCreditNoteKind(note.kind) && <KindChip kind={note.kind} />}
              <span>{note.supplier.name}</span>
              <span>{date(note.date)}</span>
              {voided && <span className="rounded-full bg-danger/10 px-2 py-0.5 text-[10px] font-medium text-danger">{t("voidedChip")}</span>}
            </div>
            {note.agreement && <p className="mt-1 text-sm">{t("agreementLine", { agreement: note.agreement })}</p>}
            {voided && (
              <p className="mt-2 rounded-xl border border-danger/20 bg-danger/5 p-3 text-xs">
                {t("voidedLine", { date: note.voidedAt ? date(note.voidedAt) : "" })}
                {note.voidReason ? ` · ${note.voidReason}` : ""}
              </p>
            )}

            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <Fact label={t("colTotal")} value={money(note.totalCents)} strong />
              <Fact label={t("balanceLabel")} value={money(note.availableCents)} strong />
              <Fact label={t("colApplied")} value={money(note.appliedCents)} />
              <Fact label={t("colRefunded")} value={money(note.refundedCents)} />
              {note.ivaCents > 0 && <Fact label={t("ivaLine", { pct: note.ivaPct })} value={money(note.ivaCents)} />}
              {note.incCents > 0 && <Fact label={t("fieldInc")} value={money(note.incCents)} />}
              {note.cude && <Fact label={t("fieldCude")} value={<span className="font-mono text-[11px] break-all">{note.cude}</span>} wide />}
              <Fact
                label={t("fieldAccount")}
                value={note.accountCode ? `${note.accountCode}${note.accountName ? ` · ${note.accountName}` : ""}` : t("accountByKind")}
                wide
              />
            </dl>
            {note.attachmentUrl && (
              <a href={note.attachmentUrl} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-xs underline text-op-muted">
                {t("viewAttachment")}
              </a>
            )}
            {note.note && <p className="mt-2 text-sm text-op-muted whitespace-pre-line">{note.note}</p>}

            {note.invoices.length > 0 && (
              <Block title={t("relatedTitle")}>
                {note.invoices.map((i) => (
                  <a key={i.id} href={`/operator/compras?oc=${encodeURIComponent(i.id)}`} className="block px-3 py-2 text-sm border-b border-op-border last:border-b-0 hover:bg-op-bg">
                    {docLabel(t, { kind: "purchase", number: i.supplierInvoiceNumber, purchaseNumber: i.number })}
                  </a>
                ))}
              </Block>
            )}

            {note.lines.length > 0 && (
              <Block title={t("linesTitle")}>
                {note.lines.map((l) => (
                  <div key={l.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm border-b border-op-border last:border-b-0">
                    <div className="min-w-0">
                      <div className="truncate">{l.ingredient.name}</div>
                      <div className="text-[11px] text-op-muted">
                        {formatBaseQty(l.qtyBase, l.ingredient.measureKind as MeasureKind, locale)}
                        {!l.inventoried && ` · ${t("notInventoried")}`}
                      </div>
                    </div>
                    <span className="tabular-nums">{money(l.valueCents)}</span>
                  </div>
                ))}
              </Block>
            )}

            <Block title={t("appliedTitle")}>
              {note.applications.length === 0 ? (
                <p className="px-3 py-2 text-xs text-op-muted">{t("notAppliedYet")}</p>
              ) : (
                note.applications.map((a) => (
                  <a
                    key={a.id}
                    href={a.kind === "purchase" ? `/operator/compras?oc=${encodeURIComponent(a.docId)}` : undefined}
                    className="flex items-center justify-between gap-3 px-3 py-2 text-sm border-b border-op-border last:border-b-0"
                  >
                    <div className="min-w-0">
                      <div className="truncate">{docLabel(t, a)}</div>
                      <div className="text-[11px] text-op-muted">{date(a.at)}</div>
                    </div>
                    <span className="tabular-nums">{`− ${money(a.amountCents)}`}</span>
                  </a>
                ))
              )}
            </Block>

            {note.refunds.length > 0 && (
              <Block title={t("refundsTitle")}>
                {note.refunds.map((r) => (
                  <div key={r.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm border-b border-op-border last:border-b-0">
                    <div className="min-w-0">
                      <div className="truncate">{r.accountName ?? r.accountCode}</div>
                      <div className="text-[11px] text-op-muted">{[date(r.receivedAt), r.note].filter(Boolean).join(" · ")}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="tabular-nums">{money(r.amountCents)}</span>
                      {!voided && (
                        <button type="button" disabled={busy} onClick={() => void deleteRefund(r.id)} className="text-[11px] text-danger min-h-[36px] px-2">
                          {t("deleteRefund")}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </Block>
            )}

            {!voided && panel === null && (
              <div className="mt-5 flex flex-wrap gap-2">
                {note.availableCents > 0 && (
                  <>
                    <button type="button" onClick={() => void openApply()} className="mp-btn mp-btn--primary mp-btn--sm">
                      {t("applyBalance")}
                    </button>
                    <button type="button" onClick={() => void openRefund()} className="mp-btn mp-btn--secondary mp-btn--sm">
                      {t("registerRefund")}
                    </button>
                  </>
                )}
                <button type="button" onClick={() => setPanel("void")} className="mp-btn mp-btn--ghost mp-btn--sm text-danger">
                  {t("voidNote")}
                </button>
              </div>
            )}

            {panel === "apply" && (
              <div className="mt-4 rounded-2xl border border-op-border p-3">
                <p className="text-sm font-medium">{t("applyBalanceTitle", { amount: money(note.availableCents) })}</p>
                {payables === null ? (
                  <p className="mt-2 text-xs text-op-muted">{t("loading")}</p>
                ) : plan.length === 0 ? (
                  <p className="mt-2 text-xs text-op-muted">{t("applyNothingPending")}</p>
                ) : (
                  <div className="mt-2 border border-op-border rounded-xl overflow-hidden">
                    {previewAllocation(plan, payables).map((d) => (
                      <div key={payableKey(d)} className="flex items-center justify-between gap-3 px-3 py-2 border-b border-op-border last:border-b-0 text-sm">
                        <div className="min-w-0">
                          <div className="truncate">{docLabel(t, d)}</div>
                          <div className="text-[11px] text-op-muted">{t("previewLine", { owes: money(d.outstandingCents), left: money(d.newOutstandingCents) })}</div>
                        </div>
                        <span className="tabular-nums font-medium">{`− ${money(d.appliedCents)}`}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="mt-3 flex gap-2 justify-end">
                  <button type="button" onClick={() => setPanel(null)} className="mp-btn mp-btn--ghost mp-btn--sm">
                    {t("cancel")}
                  </button>
                  <button
                    type="button"
                    disabled={busy || plan.length === 0}
                    onClick={() => void act(`/api/operator/supplier-credit-notes/${encodeURIComponent(note.id)}/apply`, { applications: plan })}
                    className="mp-btn mp-btn--primary mp-btn--sm"
                  >
                    {t("applyConfirm")}
                  </button>
                </div>
              </div>
            )}

            {panel === "refund" && (
              <div className="mt-4 rounded-2xl border border-op-border p-3 space-y-3">
                <p className="text-sm font-medium">{t("refundTitle")}</p>
                <p className="text-[11px] text-op-muted">{t("refundHint")}</p>
                <div className="grid grid-cols-2 gap-3">
                  <label className="min-w-0">
                    <span className="block font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">{t("refundAmount")}</span>
                    <MoneyInput
                      value={refund.amount}
                      onChange={(v) => setRefund((r) => ({ ...r, amount: v }))}
                      fractionDigits={2}
                      className="w-full min-h-[44px] px-3 rounded-xl border border-op-border bg-op-bg text-sm text-right"
                      ariaLabel={t("refundAmount")}
                    />
                  </label>
                  <label className="min-w-0">
                    <span className="block font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">{t("refundDate")}</span>
                    <input
                      type="date"
                      value={refund.date}
                      onChange={(e) => setRefund((r) => ({ ...r, date: e.target.value }))}
                      className="w-full min-h-[44px] px-3 rounded-xl border border-op-border bg-op-bg text-sm"
                    />
                  </label>
                  <label className="min-w-0 col-span-2">
                    <span className="block font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">{t("refundAccount")}</span>
                    <select
                      value={refund.accountCode}
                      onChange={(e) => setRefund((r) => ({ ...r, accountCode: e.target.value }))}
                      className="w-full min-h-[44px] px-3 rounded-xl border border-op-border bg-op-bg text-sm"
                    >
                      {accounts.map((a) => (
                        <option key={a.code} value={a.code}>{`${a.code} · ${a.name}`}</option>
                      ))}
                    </select>
                  </label>
                  <label className="min-w-0 col-span-2">
                    <span className="block font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">{t("fieldNote")}</span>
                    <input
                      value={refund.note}
                      onChange={(e) => setRefund((r) => ({ ...r, note: e.target.value }))}
                      maxLength={300}
                      className="w-full min-h-[44px] px-3 rounded-xl border border-op-border bg-op-bg text-sm"
                    />
                  </label>
                </div>
                <div className="flex gap-2 justify-end">
                  <button type="button" onClick={() => setPanel(null)} className="mp-btn mp-btn--ghost mp-btn--sm">
                    {t("cancel")}
                  </button>
                  <button
                    type="button"
                    disabled={busy || !refund.accountCode || !(Number(refund.amount) > 0)}
                    onClick={() =>
                      void act(`/api/operator/supplier-credit-notes/${encodeURIComponent(note.id)}/refunds`, {
                        amountCents: Math.round(Number(refund.amount) * 100),
                        date: refund.date,
                        accountCode: refund.accountCode,
                        note: refund.note.trim() || null,
                      })
                    }
                    className="mp-btn mp-btn--primary mp-btn--sm"
                  >
                    {t("refundConfirm")}
                  </button>
                </div>
              </div>
            )}

            {panel === "void" && (
              <div className="mt-4 rounded-2xl border border-danger/25 bg-danger/5 p-3 space-y-3">
                <p className="text-sm font-medium text-danger">{t("voidTitle")}</p>
                <p className="text-[12px]">{t("voidBody")}</p>
                <label className="block">
                  <span className="block font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">{t("voidReason")}</span>
                  <input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    maxLength={300}
                    className="w-full min-h-[44px] px-3 rounded-xl border border-op-border bg-op-bg text-sm"
                  />
                </label>
                <div className="flex gap-2 justify-end">
                  <button type="button" onClick={() => setPanel(null)} className="mp-btn mp-btn--ghost mp-btn--sm">
                    {t("cancel")}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void act(`/api/operator/supplier-credit-notes/${encodeURIComponent(note.id)}/void`, { reason: reason.trim() || null })}
                    className="mp-btn mp-btn--primary mp-btn--sm bg-danger! border-danger!"
                  >
                    {t("voidConfirm")}
                  </button>
                </div>
              </div>
            )}

            {err && (
              <p role="alert" className="mt-3 text-sm text-danger">
                {err}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Fact({ label, value, strong, wide }: { label: string; value: ReactNode; strong?: boolean; wide?: boolean }) {
  return (
    <div className={"min-w-0" + (wide ? " col-span-2" : "")}>
      <dt className="font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted">{label}</dt>
      <dd className={"tabular-nums " + (strong ? "font-semibold" : "")}>{value}</dd>
    </div>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-4">
      <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1.5">{title}</div>
      <div className="border border-op-border rounded-2xl overflow-hidden">{children}</div>
    </div>
  );
}
