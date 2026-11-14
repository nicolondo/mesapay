"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatDate, formatMoney } from "@/lib/format";
import { MoneyInput } from "@/components/MoneyInput";
import { SupplierCombobox } from "@/components/suppliers/SupplierCombobox";
import { payableKey, type PayableDocRef } from "@/lib/erp/supplierCreditAllocation";
import {
  creditKey,
  planSupplierPayment,
  SUPPLIER_PAYMENT_METHODS,
  type PaymentCredit,
  type SupplierPaymentMethod,
} from "@/lib/erp/supplierPaymentPlan";
import { docLabel } from "../notas-credito/docLabel";

export type SupplierRef = { id: string; name: string; taxId: string | null };

type Context = { payables: PayableDocRef[]; credits: PaymentCredit[]; accounts: { code: string; name: string }[] };

const toMajor = (c: number) => String(c / 100);
const toCents = (raw: string) => {
  const n = Number(raw);
  return raw.trim() === "" || !Number.isFinite(n) ? 0 : Math.round(n * 100);
};
const todayInput = () => {
  const d = new Date();
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const ERROR_KEYS: Record<string, string> = {
  plan_changed: "errPlanChanged",
  account_invalid: "errAccount",
  month_closed: "errMonthClosed",
  amount_invalid: "errAmount",
  supplier_not_found: "errSupplier",
};

/**
 * «Pagar a proveedor». Al elegir el proveedor trae TODO lo pendiente (compras
 * y gastos, ordenados por vencimiento y fecha) y sus saldos a favor (notas
 * crédito y anticipos). Se cruzan primero los saldos a favor marcados y luego
 * el dinero, FIFO en el orden de la lista (se puede desmarcar y reordenar);
 * la vista previa muestra por factura saldo → cruce → pago → saldo nuevo. Si
 * se paga de más, el excedente queda como anticipo (se avisa).
 */
export function PayToSupplierSheet({
  suppliers,
  currency,
  initialSupplierId,
  onClose,
  onSaved,
}: {
  suppliers: SupplierRef[];
  currency: string;
  initialSupplierId: string | null;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const t = useTranslations("opSupplierPayment");
  const tc = useTranslations("opSupplierCredit");
  const locale = useLocale() as Locale;
  const money = (c: number) => formatMoney(c, { currency, locale, fractionDigits: "auto" });
  const [supplierId, setSupplierId] = useState<string | null>(initialSupplierId);
  const [ctx, setCtx] = useState<Context | null>(null);
  const [ctxErr, setCtxErr] = useState(false);
  const [order, setOrder] = useState<string[]>([]);
  const [skipDocs, setSkipDocs] = useState<Set<string>>(new Set());
  const [skipCredits, setSkipCredits] = useState<Set<string>>(new Set());
  const [amount, setAmount] = useState("");
  const [amountTouched, setAmountTouched] = useState(false);
  const [date, setDate] = useState(todayInput());
  const [accountCode, setAccountCode] = useState("");
  const [method, setMethod] = useState<SupplierPaymentMethod>("transfer");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [attachmentUrl, setAttachmentUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "attach" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!supplierId) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/operator/supplier-payments/context?supplierId=${encodeURIComponent(supplierId)}`, { cache: "no-store" });
        if (!r.ok) throw new Error("ctx");
        const j = (await r.json()) as Context;
        if (cancelled) return;
        setCtx(j);
        setCtxErr(false);
        setOrder(j.payables.map(payableKey));
        setSkipDocs(new Set());
        setSkipCredits(new Set());
        setAmountTouched(false);
        setAccountCode((prev) => prev || j.accounts[0]?.code || "");
      } catch {
        if (!cancelled) setCtxErr(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supplierId]);

  const docsByKey = useMemo(() => new Map((ctx?.payables ?? []).map((d) => [payableKey(d), d])), [ctx]);
  const orderedDocs = order.map((k) => docsByKey.get(k)).filter((d): d is PayableDocRef => !!d);
  const selectedDocs = orderedDocs.filter((d) => !skipDocs.has(payableKey(d)));
  const selectedCredits = (ctx?.credits ?? []).filter((c) => !skipCredits.has(creditKey(c)));
  // Sin tocar el monto, se propone el neto a pagar (pendiente − saldos a favor).
  const draft = planSupplierPayment({ docs: selectedDocs, credits: selectedCredits, amountCents: 0 });
  const amountCents = amountTouched ? toCents(amount) : draft.totals.netToPayCents;
  const plan = planSupplierPayment({ docs: selectedDocs, credits: selectedCredits, amountCents });
  const planByKey = new Map(plan.docs.map((d) => [payableKey(d), d]));
  const canSave =
    !!supplierId && !!accountCode && busy === null && (amountCents > 0 || plan.totals.creditsCents > 0) && selectedDocs.length + (amountCents > 0 ? 1 : 0) > 0;

  function move(key: string, dir: -1 | 1) {
    setOrder((prev) => {
      const i = prev.indexOf(key);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  }
  const toggle = (set: Set<string>, key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };

  async function attach(file: File) {
    setBusy("attach");
    try {
      const body = new FormData();
      body.append("file", file);
      body.append("kind", "ce");
      const r = await fetch("/api/operator/supplier-credit-notes/attachments", { method: "POST", body });
      const j = await r.json().catch(() => null);
      if (r.ok && j?.fileUrl) setAttachmentUrl(j.fileUrl as string);
      else setErr(t("errUpload"));
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    if (!canSave || !supplierId) return;
    setBusy("save");
    setErr(null);
    try {
      const r = await fetch("/api/operator/supplier-payments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          supplierId,
          date,
          accountCode,
          method,
          reference: reference.trim() || null,
          note: note.trim() || null,
          attachmentUrl,
          amountCents,
          docs: selectedDocs.map((d) => ({ kind: d.kind, id: d.id })),
          credits: selectedCredits.map((c) => ({ source: c.source, id: c.id })),
          expectedNetCents: plan.totals.netToPayCents,
        }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok) {
        setErr(t(ERROR_KEYS[j?.error as string] ?? "errSave"));
        return;
      }
      onSaved(j.id as string);
    } catch {
      setErr(t("errSave"));
    } finally {
      setBusy(null);
    }
  }

  const label = "block font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1";
  const field = "w-full min-h-[44px] px-3 rounded-xl border border-op-border bg-op-bg text-sm";

  return (
    <div className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="pay-supplier-title"
        className="w-full md:max-w-3xl bg-op-surface rounded-t-3xl md:rounded-3xl border border-op-border p-5 max-h-[94dvh] overflow-y-auto"
      >
        <div className="flex items-start justify-between gap-3 mb-1">
          <h2 id="pay-supplier-title" className="font-display text-2xl">
            {t("sheetTitle")}
          </h2>
          <button type="button" onClick={onClose} className="text-op-muted text-sm shrink-0 min-h-[44px] min-w-[44px] -mt-2 -mr-2" aria-label={t("close")}>
            {"✕"}
          </button>
        </div>
        <p className="text-[12px] text-op-muted mb-4">{t("sheetHint")}</p>

        <span className={label}>{t("fieldSupplier")}</span>
        <SupplierCombobox suppliers={suppliers} value={supplierId} onChange={(id) => { setSupplierId(id); setCtx(null); }} placeholder={tc("fieldSupplierPlaceholder")} />

        {supplierId && ctxErr && <p className="mt-2 text-xs text-danger">{t("errContext")}</p>}
        {supplierId && !ctx && !ctxErr && <p className="mt-2 text-xs text-op-muted">{t("loading")}</p>}

        {ctx && (
          <>
            {/* Lo pendiente, en orden FIFO (se puede desmarcar y reordenar). */}
            <div className="mt-4 flex items-center justify-between">
              <span className={label}>{t("pendingTitle")}</span>
              <span className="text-[11px] text-op-muted">{t("pendingHint")}</span>
            </div>
            {orderedDocs.length === 0 ? (
              <p className="text-xs text-op-muted">{t("nothingPending")}</p>
            ) : (
              <div className="border border-op-border rounded-2xl overflow-hidden">
                <div className="hidden sm:grid grid-cols-[2rem_minmax(0,1fr)_7rem_7rem_7rem_7rem_3.5rem] gap-2 px-3 py-2 border-b border-op-border font-mono text-[9px] tracking-[0.12em] uppercase text-op-muted">
                  <span />
                  <span>{t("colDoc")}</span>
                  <span className="text-right">{t("colBalance")}</span>
                  <span className="text-right">{t("colCredit")}</span>
                  <span className="text-right">{t("colPayment")}</span>
                  <span className="text-right">{t("colNewBalance")}</span>
                  <span />
                </div>
                {orderedDocs.map((d, i) => {
                  const k = payableKey(d);
                  const on = !skipDocs.has(k);
                  const p = planByKey.get(k);
                  return (
                    <div key={k} className={"grid grid-cols-[2rem_minmax(0,1fr)_auto] sm:grid-cols-[2rem_minmax(0,1fr)_7rem_7rem_7rem_7rem_3.5rem] gap-2 items-center px-3 py-2 border-b border-op-border last:border-b-0 text-sm" + (on ? "" : " opacity-50")}>
                      <input type="checkbox" checked={on} onChange={() => setSkipDocs((s) => toggle(s, k))} className="h-5 w-5" aria-label={t("includeDoc", { doc: docLabel(tc, d) })} />
                      <div className="min-w-0">
                        <div className="truncate">{docLabel(tc, d)}</div>
                        <div className="text-[11px] text-op-muted">{tc("dueOn", { date: formatDate(`${d.dueDate}T12:00:00Z`, { locale, timeStyle: undefined }) })}</div>
                        {/* Celular: el desglose en una línea. */}
                        {on && p && (
                          <div className="sm:hidden text-[11px] text-op-muted tabular-nums">
                            {t("previewLineMobile", { owes: money(d.outstandingCents), credit: money(p.creditCents), pay: money(p.moneyCents), left: money(p.newOutstandingCents) })}
                          </div>
                        )}
                      </div>
                      <span className="hidden sm:block text-right tabular-nums">{money(d.outstandingCents)}</span>
                      <span className="hidden sm:block text-right tabular-nums text-[#2F6B4F]">{p && p.creditCents ? `− ${money(p.creditCents)}` : "—"}</span>
                      <span className="hidden sm:block text-right tabular-nums">{p && p.moneyCents ? `− ${money(p.moneyCents)}` : "—"}</span>
                      <span className="hidden sm:block text-right tabular-nums font-medium">{p ? money(p.newOutstandingCents) : money(d.outstandingCents)}</span>
                      <div className="flex justify-end gap-0.5">
                        <button type="button" onClick={() => move(k, -1)} disabled={i === 0} className="min-h-[32px] min-w-[24px] text-op-muted disabled:opacity-30" aria-label={t("moveUp")}>
                          {"↑"}
                        </button>
                        <button type="button" onClick={() => move(k, 1)} disabled={i === orderedDocs.length - 1} className="min-h-[32px] min-w-[24px] text-op-muted disabled:opacity-30" aria-label={t("moveDown")}>
                          {"↓"}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Saldos a favor: se cruzan antes del dinero. */}
            {ctx.credits.length > 0 && (
              <div className="mt-4">
                <span className={label}>{t("creditsTitle")}</span>
                <div className="border border-op-border rounded-2xl overflow-hidden">
                  {ctx.credits.map((c) => {
                    const k = creditKey(c);
                    const used = plan.creditUses.filter((u) => u.source === c.source && u.creditId === c.id).reduce((s, u) => s + u.amountCents, 0);
                    return (
                      <label key={k} className="flex items-center gap-3 px-3 py-2 border-b border-op-border last:border-b-0 text-sm">
                        <input type="checkbox" checked={!skipCredits.has(k)} onChange={() => setSkipCredits((s) => toggle(s, k))} className="h-5 w-5" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">
                            {c.source === "note" ? t("creditNote", { number: c.label }) : t("creditAdvance", { number: c.label.padStart(4, "0") })}
                          </span>
                          <span className="block text-[11px] text-op-muted">
                            {c.relatedKeys.length > 0 ? t("creditRelated") : t("creditFifo")}
                          </span>
                        </span>
                        <span className="text-right tabular-nums">
                          <span className="block">{money(c.availableCents)}</span>
                          {used > 0 && <span className="block text-[11px] text-[#2F6B4F]">{t("creditUsed", { amount: money(used) })}</span>}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Totales */}
            <dl className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Total label={t("totalPending")} value={money(plan.totals.pendingCents)} />
              <Total label={t("totalCredits")} value={`− ${money(plan.totals.creditsCents)}`} tone="ok" />
              <Total label={t("totalNet")} value={money(plan.totals.netToPayCents)} strong />
              <Total label={t("totalPaying")} value={money(amountCents)} strong />
            </dl>

            <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="min-w-0">
                <span className={label}>{t("fieldAmount")}</span>
                <MoneyInput
                  value={amountTouched ? amount : toMajor(draft.totals.netToPayCents)}
                  onChange={(v) => {
                    setAmountTouched(true);
                    setAmount(v);
                  }}
                  fractionDigits={2}
                  className={field + " text-right"}
                  ariaLabel={t("fieldAmount")}
                />
              </label>
              <label className="min-w-0">
                <span className={label}>{t("fieldDate")}</span>
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={field} />
              </label>
              <label className="min-w-0">
                <span className={label}>{t("fieldAccount")}</span>
                <select value={accountCode} onChange={(e) => setAccountCode(e.target.value)} className={field}>
                  {ctx.accounts.map((a) => (
                    <option key={a.code} value={a.code}>{`${a.code} · ${a.name}`}</option>
                  ))}
                </select>
              </label>
              <label className="min-w-0">
                <span className={label}>{t("fieldMethod")}</span>
                <select value={method} onChange={(e) => setMethod(e.target.value as SupplierPaymentMethod)} className={field}>
                  {SUPPLIER_PAYMENT_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {t(`method_${m}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="min-w-0">
                <span className={label}>{t("fieldReference")}</span>
                <input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} className={field} placeholder={t("fieldReferencePlaceholder")} />
              </label>
              <div className="min-w-0">
                <span className={label}>{t("fieldAttachment")}</span>
                <div className="flex items-center gap-2 min-h-[44px]">
                  <button type="button" disabled={busy !== null} onClick={() => fileRef.current?.click()} className="mp-btn mp-btn--secondary mp-btn--sm">
                    {attachmentUrl ? t("attachReplace") : t("attach")}
                  </button>
                  {attachmentUrl && (
                    <a href={attachmentUrl} target="_blank" rel="noopener noreferrer" className="text-xs underline text-op-muted">
                      {t("attachView")}
                    </a>
                  )}
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".pdf,image/*"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.target.value = "";
                      if (f) void attach(f);
                    }}
                  />
                </div>
              </div>
              <label className="min-w-0 sm:col-span-2">
                <span className={label}>{t("fieldNote")}</span>
                <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} className={field} />
              </label>
            </div>

            {plan.totals.advanceCents > 0 && (
              <div role="alert" className="mt-3 rounded-2xl border border-[#C98A2E]/35 bg-[#C98A2E]/10 p-3 text-sm text-[#7F5A1F]">
                <p className="font-medium">{t("advanceTitle", { amount: money(plan.totals.advanceCents) })}</p>
                <p className="mt-0.5 text-[12px]">{t("advanceBody")}</p>
              </div>
            )}
            {plan.totals.advanceCents === 0 && plan.totals.leftUnpaidCents > 0 && amountCents > 0 && (
              <p className="mt-3 text-[12px] text-op-muted">{t("partialHint", { amount: money(plan.totals.leftUnpaidCents) })}</p>
            )}
          </>
        )}

        {err && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {err}
          </p>
        )}
        <div className="mt-5 flex gap-2 justify-end sticky bottom-0 bg-op-surface pt-2">
          <button type="button" onClick={onClose} className="mp-btn mp-btn--ghost">
            {t("cancel")}
          </button>
          <button type="button" onClick={() => void save()} disabled={!canSave} className="mp-btn mp-btn--primary">
            {busy === "save" ? t("saving") : t("save", { amount: money(amountCents) })}
          </button>
        </div>
      </div>
    </div>
  );
}

function Total({ label, value, strong, tone }: { label: string; value: string; strong?: boolean; tone?: "ok" }) {
  return (
    <div className="rounded-xl border border-op-border px-3 py-2 min-w-0">
      <dt className="font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted truncate">{label}</dt>
      <dd className={"tabular-nums truncate " + (strong ? "font-semibold" : "") + (tone === "ok" ? " text-[#2F6B4F]" : "")}>{value}</dd>
    </div>
  );
}
