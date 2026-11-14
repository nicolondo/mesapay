"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatDate, formatMoney, formatNumber } from "@/lib/format";
import { MoneyInput } from "@/components/MoneyInput";
import { parseDecimalInput, sanitizeDecimalInput } from "@/lib/decimalInput";
import { SupplierCombobox } from "@/components/suppliers/SupplierCombobox";
import { purchaseTaxRates } from "@/lib/erp/purchaseTax";
import { displayUnitFor, toBaseQty, type MeasureKind } from "@/lib/erp/units";
import {
  accountIsConfigurable,
  creditNoteAmountError,
  defaultCreditNoteAccount,
  KIND_LABEL_KEY,
  SUPPLIER_CREDIT_NOTE_KINDS,
  type SupplierCreditNoteKind,
} from "@/lib/erp/supplierCreditNotes";
import {
  allocatedCents,
  payableKey,
  planCreditAllocation,
  previewAllocation,
  sortPayablesFifo,
  type CreditAllocation,
  type PayableDocRef,
} from "@/lib/erp/supplierCreditAllocation";
import type { InitialReading, SupplierRef } from "./CreditNotesClient";
import { docLabel } from "./docLabel";

type InvoiceOption = {
  id: string;
  number: number;
  status: string;
  date: string;
  supplierInvoiceNumber: string | null;
  items: {
    id: string;
    ingredient: { id: string; name: string; measureKind: MeasureKind };
    receivedQtyBase: number;
    receivedCostCents: number;
  }[];
};

type Context = {
  payables: PayableDocRef[];
  availableCents: number;
  invoices: InvoiceOption[];
  agreements: string[];
  accounts: { code: string; name: string }[];
};

type Duplicate = { id: string; number: string; date: string; totalCents: number; supplierName: string; reason: "number" | "cude" };

/** Línea de devolución en edición: cantidad en la unidad que se muestra y valor sin IVA. */
type ReturnLine = { qty: string; value: string };

const centsToMajor = (c: number | null | undefined) => (c == null ? "" : String(c / 100));
const majorToCents = (raw: string) => {
  const n = Number(raw);
  return raw.trim() === "" || !Number.isFinite(n) ? 0 : Math.round(n * 100);
};
const todayInput = () => {
  const d = new Date();
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** IVA embebido en un total con esa tarifa (para sugerirlo; el operador lo corrige). */
function embeddedIva(totalCents: number, incCents: number, pct: number): number {
  if (!(pct > 0) || totalCents <= 0) return 0;
  const gross = totalCents - incCents;
  return Math.round((gross * pct) / (100 + pct));
}

const ERROR_KEYS: Record<string, string> = {
  invalid: "errInvalid",
  supplier_not_found: "errSupplier",
  purchase_not_found: "errInvoice",
  return_needs_invoice: "errReturnNeedsInvoice",
  ingredient_not_found: "errLine",
  line_invalid: "errLine",
  total_invalid: "errTotal",
  tax_invalid: "errTax",
  base_invalid: "errBase",
  lines_required: "errLinesRequired",
  lines_mismatch: "errLinesMismatch",
  account_invalid: "errAccount",
  month_closed: "errMonthClosed",
  exceeds_balance: "errPlanChanged",
  exceeds_available: "errPlanTooMuch",
  unknown_doc: "errPlanChanged",
  amount_invalid: "errInvalid",
  duplicate_doc: "errInvalid",
  ingredient_not_tracked: "errLine",
  ingredient_inactive: "errLine",
};

/**
 * Formulario de una nota crédito de proveedor (hoja). Se puede prellenar con
 * una lectura con IA. Al elegir el proveedor trae lo que se le debe, su
 * saldo a favor y sus compras; muestra en vivo cómo se va a aplicar la nota
 * (las facturas que relaciona primero, luego FIFO) y deja cambiarlo o dejar
 * todo como saldo a favor. Las devoluciones se arman con los ítems de las
 * facturas relacionadas.
 */
export function CreditNoteForm({
  suppliers,
  currency,
  country,
  ivaDeductible,
  reading,
  onClose,
  onSaved,
}: {
  suppliers: SupplierRef[];
  currency: string;
  country: string | null;
  ivaDeductible: boolean;
  reading: InitialReading | null;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const t = useTranslations("opSupplierCredit");
  const locale = useLocale() as Locale;
  const money = (c: number) => formatMoney(c, { currency, locale, fractionDigits: "auto" });
  const pre = reading?.prefill ?? null;

  const [supplierId, setSupplierId] = useState<string | null>(pre?.supplierId ?? null);
  const [number, setNumber] = useState(pre?.number ?? "");
  const [date, setDate] = useState(pre?.date ?? todayInput());
  const [cude, setCude] = useState(pre?.cude ?? "");
  const [kind, setKind] = useState<SupplierCreditNoteKind>(pre?.kind ?? "discount");
  const [agreement, setAgreement] = useState(pre?.kind === "agreement" ? (pre?.concept ?? "") : "");
  const [total, setTotal] = useState(centsToMajor(pre?.totalCents));
  const [hasTax, setHasTax] = useState(Boolean(pre?.ivaCents || pre?.incCents));
  const [ivaPct, setIvaPct] = useState<number>(pre?.ivaPct ?? 19);
  const [iva, setIva] = useState(centsToMajor(pre?.ivaCents));
  const [inc, setInc] = useState(centsToMajor(pre?.incCents));
  const [accountCode, setAccountCode] = useState("");
  const [note, setNote] = useState(pre?.concept && pre?.kind !== "agreement" ? pre.concept : "");
  const [attachmentUrl, setAttachmentUrl] = useState<string | null>(reading?.fileUrl ?? null);
  const [aiNote, setAiNote] = useState<{ tone: "ok" | "warn"; text: string } | null>(
    pre ? { tone: pre.isCreditNote ? "ok" : "warn", text: pre.isCreditNote ? t("aiDone") : t("aiNotCreditNote") } : null,
  );
  const [related, setRelated] = useState<string[]>(pre?.relatedPurchaseIds ?? []);
  const [returnLines, setReturnLines] = useState<Record<string, ReturnLine>>({});
  const [mode, setMode] = useState<"auto" | "manual" | "none">("auto");
  const [manual, setManual] = useState<Record<string, string>>({});
  const [ctx, setCtx] = useState<Context | null>(null);
  const [ctxErr, setCtxErr] = useState(false);
  const [duplicate, setDuplicate] = useState<Duplicate | null>(null);
  const [busy, setBusy] = useState<"save" | "read" | "attach" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const readRef = useRef(false);

  // Contexto del proveedor: lo que se le debe, saldo a favor, compras, cuentas.
  useEffect(() => {
    if (!supplierId) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/operator/supplier-credit-notes/context?supplierId=${encodeURIComponent(supplierId)}&accounts=1`);
        if (!r.ok) throw new Error("ctx");
        const j = (await r.json()) as Context;
        if (!cancelled) {
          setCtx(j);
          setCtxErr(false);
        }
      } catch {
        if (!cancelled) setCtxErr(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supplierId]);

  // Aviso temprano de nota repetida (el bloqueo real lo hace el servidor).
  const dupKey = supplierId && (number.trim() || cude.trim()) ? `${supplierId}|${number.trim()}|${cude.trim()}` : "";
  useEffect(() => {
    if (!dupKey) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const [sid, n, c] = dupKey.split("|");
      const qs = new URLSearchParams({ supplierId: sid!, invoices: "0" });
      if (n) qs.set("number", n);
      if (c) qs.set("cude", c);
      try {
        const r = await fetch(`/api/operator/supplier-credit-notes/context?${qs}`);
        if (!r.ok) return;
        const j = (await r.json()) as { duplicate: Duplicate | null };
        if (!cancelled) setDuplicate(j.duplicate);
      } catch {
        // Sin red: el servidor igual bloquea al guardar.
      }
    }, 450);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [dupKey]);

  const invoices = useMemo(() => (supplierId ? (ctx?.invoices ?? []) : []), [ctx, supplierId]);
  const relatedInvoices = invoices.filter((i) => related.includes(i.id));
  const returnItems = relatedInvoices.flatMap((inv) => inv.items.map((it) => ({ inv, it })));

  // Montos.
  const ivaCents = hasTax ? majorToCents(iva) : 0;
  const incCents = hasTax ? majorToCents(inc) : 0;
  const lines = returnItems
    .map(({ it }) => {
      const l = returnLines[it.id];
      if (!l) return null;
      const unit = displayUnitFor(it.receivedQtyBase, it.ingredient.measureKind);
      const qtyBase = toBaseQty(parseDecimalInput(l.qty), it.ingredient.measureKind, unit.symbol);
      const valueCents = majorToCents(l.value);
      return { itemId: it.id, ingredientId: it.ingredient.id, qtyBase, valueCents };
    })
    .filter((l): l is NonNullable<typeof l> => l != null);
  const linesBase = lines.reduce((s, l) => s + l.valueCents, 0);
  const totalCents = kind === "return" ? linesBase + ivaCents + incCents : majorToCents(total);
  const amountErr = creditNoteAmountError({
    kind,
    totalCents,
    ivaCents,
    incCents,
    ivaDeductible,
    lines: lines.map((l) => ({ valueCents: l.valueCents, inventoried: true })),
  });

  // Aplicación.
  const payables = useMemo(() => (supplierId ? sortPayablesFifo(ctx?.payables ?? []) : []), [ctx, supplierId]);
  const relatedKeys = related.map((id) => payableKey({ kind: "purchase", id }));
  const autoPlan = planCreditAllocation(totalCents, payables, relatedKeys);
  const manualPlan: CreditAllocation[] = payables
    .map((d) => ({ kind: d.kind, id: d.id, amountCents: majorToCents(manual[payableKey(d)] ?? "") }))
    .filter((a) => a.amountCents > 0);
  const plan = mode === "none" ? [] : mode === "manual" ? manualPlan : autoPlan;
  const applied = allocatedCents(plan);
  const leftover = Math.max(0, totalCents - applied);
  const manualErr =
    mode === "manual" &&
    (applied > totalCents || manualPlan.some((a) => a.amountCents > (payables.find((d) => d.id === a.id)?.outstandingCents ?? 0)));

  function toggleRelated(id: string) {
    setRelated((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function setReturnQty(itemId: string, qty: string, unitCost: number, displayFactor: number) {
    const n = parseDecimalInput(qty);
    const suggested = Number.isFinite(n) && n > 0 ? Math.round(n * displayFactor * unitCost) : 0;
    setReturnLines((prev) => {
      const cur = prev[itemId];
      // El valor se sugiere al costo de la compra mientras el operador no lo cambie.
      const touched = cur && cur.value !== "" && majorToCents(cur.value) !== Math.round((parseDecimalInput(cur.qty) || 0) * displayFactor * unitCost);
      if (!qty.trim()) {
        const next = { ...prev };
        delete next[itemId];
        return next;
      }
      return { ...prev, [itemId]: { qty, value: touched ? cur!.value : centsToMajor(suggested) } };
    });
  }

  async function uploadFile(file: File, read: boolean) {
    if (readRef.current) return;
    readRef.current = true;
    setBusy(read ? "read" : "attach");
    setErr(null);
    try {
      const body = new FormData();
      body.append("file", file);
      if (read) body.append("read", "1");
      const r = await fetch("/api/operator/supplier-credit-notes/attachments", { method: "POST", body });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.fileUrl) {
        setErr(t("errUpload"));
        return;
      }
      setAttachmentUrl(j.fileUrl);
      if (!read) return;
      if (j.aiError) {
        setAiNote({ tone: "warn", text: t(j.aiError === "ai_unavailable" ? "aiUnavailable" : j.aiError === "not_a_document" ? "aiNotDocument" : "aiFailed") });
        return;
      }
      const p = j.prefill as InitialReading["prefill"];
      if (p.supplierId) setSupplierId(p.supplierId);
      if (p.number) setNumber(p.number);
      if (p.date) setDate(p.date);
      if (p.cude) setCude(p.cude);
      if (p.kind) setKind(p.kind);
      if (p.kind === "agreement" && p.concept) setAgreement(p.concept);
      else if (p.concept) setNote(p.concept);
      if (p.totalCents) setTotal(centsToMajor(p.totalCents));
      if (p.ivaCents || p.incCents) {
        setHasTax(true);
        setIva(centsToMajor(p.ivaCents));
        setInc(centsToMajor(p.incCents));
        if (p.ivaPct != null) setIvaPct(p.ivaPct);
      }
      if (p.relatedPurchaseIds.length) setRelated(p.relatedPurchaseIds);
      const notes = [p.isCreditNote ? t("aiDone") : t("aiNotCreditNote")];
      if (!p.supplierId && p.supplierName) notes.push(t("aiSupplierUnknown", { name: p.supplierName }));
      setAiNote({ tone: p.isCreditNote && p.supplierId ? "ok" : "warn", text: notes.join(" ") });
    } catch {
      setErr(t("errUpload"));
    } finally {
      readRef.current = false;
      setBusy(null);
    }
  }

  async function save() {
    if (!supplierId || amountErr || manualErr || duplicate || busy) return;
    setBusy("save");
    setErr(null);
    try {
      const r = await fetch("/api/operator/supplier-credit-notes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          supplierId,
          number: number.trim(),
          date,
          cude: cude.trim() || null,
          kind,
          agreement: kind === "agreement" ? agreement.trim() || null : null,
          totalCents,
          ivaPct: ivaCents > 0 ? ivaPct : 0,
          ivaCents,
          incCents,
          accountCode: accountIsConfigurable(kind) && accountCode ? accountCode : null,
          note: note.trim() || null,
          attachmentUrl,
          invoiceUploadId: reading?.uploadId ?? null,
          relatedPurchaseIds: related,
          lines:
            kind === "return"
              ? lines.map((l) => ({ ingredientId: l.ingredientId, purchaseOrderItemId: l.itemId, qtyBase: l.qtyBase ?? 0, valueCents: l.valueCents }))
              : [],
          applications: plan,
        }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok) {
        if (j?.error === "duplicate_credit_note" && j.duplicate) {
          setDuplicate(j.duplicate as Duplicate);
          return;
        }
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

  const rates = purchaseTaxRates(country);
  const defaultAccount = defaultCreditNoteAccount(kind);
  const accountName = (code: string) => ctx?.accounts.find((a) => a.code === code)?.name ?? null;
  const returnsMissingQty = kind === "return" && lines.some((l) => l.qtyBase == null);
  const canSave =
    !!supplierId && number.trim() !== "" && !amountErr && !manualErr && !duplicate && !returnsMissingQty && busy === null;

  const field = "w-full min-h-[44px] px-3 rounded-xl border border-op-border bg-op-bg text-sm";
  const label = "block font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1";

  return (
    <div className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="credit-note-form-title"
        className="w-full md:max-w-2xl bg-op-surface rounded-t-3xl md:rounded-3xl border border-op-border p-5 max-h-[94dvh] overflow-y-auto"
      >
        <div className="flex items-start justify-between gap-3 mb-1">
          <h2 id="credit-note-form-title" className="font-display text-2xl">
            {t("formTitle")}
          </h2>
          <button type="button" onClick={onClose} className="text-op-muted text-sm shrink-0 min-h-[44px] min-w-[44px] -mt-2 -mr-2" aria-label={t("close")}>
            {"✕"}
          </button>
        </div>
        <p className="text-[12px] text-op-muted mb-4">{t("formHint")}</p>

        {/* Soporte + lectura con IA */}
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <button type="button" disabled={busy !== null} onClick={() => fileRef.current?.click()} className="mp-btn mp-btn--secondary mp-btn--sm">
            {busy === "read" ? t("aiReading") : t("aiRead")}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void uploadFile(f, true);
            }}
          />
          {attachmentUrl && (
            <a href={attachmentUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-op-muted underline">
              {t("viewAttachment")}
            </a>
          )}
        </div>
        {aiNote && (
          <div
            role="status"
            className={
              "mb-4 rounded-xl border p-3 text-xs " +
              (aiNote.tone === "ok" ? "border-op-border bg-op-bg text-op-text" : "border-[#C98A2E]/35 bg-[#C98A2E]/10 text-[#7F5A1F]")
            }
          >
            {aiNote.text}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2">
            <span className={label}>{t("fieldSupplier")}</span>
            <SupplierCombobox
              suppliers={suppliers}
              value={supplierId}
              onChange={(id) => {
                setSupplierId(id);
                setCtx(null);
                setRelated([]);
                setReturnLines({});
                setManual({});
              }}
              placeholder={t("fieldSupplierPlaceholder")}
            />
          </div>
          <label className="min-w-0">
            <span className={label}>{t("fieldNumber")}</span>
            <input value={number} onChange={(e) => setNumber(e.target.value)} className={field} placeholder="NC-0001" />
          </label>
          <label className="min-w-0">
            <span className={label}>{t("fieldDate")}</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={field} />
          </label>
          <label className="min-w-0 sm:col-span-2">
            <span className={label}>{t("fieldCude")}</span>
            <input value={cude} onChange={(e) => setCude(e.target.value)} className={field + " font-mono text-xs"} placeholder={t("fieldCudePlaceholder")} />
          </label>
        </div>

        {duplicate && (
          <div role="alert" className="mt-3 rounded-2xl border border-danger/25 bg-danger/5 p-3.5 text-sm">
            <p className="font-medium text-danger">{t(duplicate.reason === "cude" ? "dupCudeTitle" : "dupTitle")}</p>
            <p className="mt-1">
              {[duplicate.number, duplicate.supplierName, formatDate(duplicate.date, { locale, timeStyle: undefined }), money(duplicate.totalCents)].join(" · ")}
            </p>
            <a href={`/operator/compras/notas-credito?nota=${encodeURIComponent(duplicate.id)}`} target="_blank" rel="noopener noreferrer" className="mp-btn mp-btn--secondary mp-btn--sm mt-2">
              {t("dupOpen")}
            </a>
          </div>
        )}

        {/* Tipo */}
        <fieldset className="mt-4">
          <legend className={label}>{t("fieldKind")}</legend>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {SUPPLIER_CREDIT_NOTE_KINDS.map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={kind === k}
                onClick={() => setKind(k)}
                className={
                  "min-h-[44px] rounded-xl border px-2 text-sm text-left " +
                  (kind === k ? "border-ink bg-ink text-bone" : "border-op-border bg-op-bg hover:border-ink/40")
                }
              >
                {t(KIND_LABEL_KEY[k])}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] text-op-muted">{t(`kindHint_${kind}`)}</p>
        </fieldset>

        {kind === "agreement" && (
          <label className="block mt-3">
            <span className={label}>{t("fieldAgreement")}</span>
            <input
              value={agreement}
              onChange={(e) => setAgreement(e.target.value)}
              list="credit-note-agreements"
              className={field}
              placeholder={t("fieldAgreementPlaceholder")}
              maxLength={120}
            />
            <datalist id="credit-note-agreements">
              {(ctx?.agreements ?? []).map((a) => (
                <option key={a} value={a} />
              ))}
            </datalist>
          </label>
        )}

        {/* Facturas relacionadas */}
        {supplierId && (
          <div className="mt-4">
            <span className={label}>{t(kind === "return" ? "fieldInvoicesReturn" : "fieldInvoices")}</span>
            {ctxErr ? (
              <p className="text-xs text-danger">{t("errContext")}</p>
            ) : !ctx ? (
              <p className="text-xs text-op-muted">{t("loading")}</p>
            ) : invoices.length === 0 ? (
              <p className="text-xs text-op-muted">{t("noInvoices")}</p>
            ) : (
              <div className="flex flex-wrap gap-1.5 max-h-36 overflow-y-auto">
                {invoices.map((inv) => (
                  <button
                    key={inv.id}
                    type="button"
                    aria-pressed={related.includes(inv.id)}
                    onClick={() => toggleRelated(inv.id)}
                    className={
                      "min-h-[36px] rounded-full border px-3 text-xs " +
                      (related.includes(inv.id) ? "border-ink bg-ink text-bone" : "border-op-border bg-op-bg")
                    }
                  >
                    {docLabel(t, { kind: "purchase", number: inv.supplierInvoiceNumber, purchaseNumber: inv.number })}
                    {" · "}
                    {formatDate(inv.date, { locale, timeStyle: undefined })}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Devolución: ítems de las facturas relacionadas */}
        {kind === "return" && (
          <div className="mt-4">
            <span className={label}>{t("fieldReturnLines")}</span>
            {returnItems.length === 0 ? (
              <p className="text-xs text-op-muted">{t("returnPickInvoice")}</p>
            ) : (
              <div className="border border-op-border rounded-2xl overflow-hidden">
                {returnItems.map(({ inv, it }) => {
                  const unit = displayUnitFor(it.receivedQtyBase, it.ingredient.measureKind);
                  const unitCost = it.receivedQtyBase > 0 ? it.receivedCostCents / it.receivedQtyBase : 0;
                  const l = returnLines[it.id];
                  return (
                    <div key={it.id} className="grid grid-cols-[minmax(0,1fr)_6.5rem_8rem] gap-2 items-center px-3 py-2 border-b border-op-border last:border-b-0">
                      <div className="min-w-0">
                        <div className="text-sm truncate">{it.ingredient.name}</div>
                        <div className="text-[11px] text-op-muted truncate">
                          {docLabel(t, { kind: "purchase", number: inv.supplierInvoiceNumber, purchaseNumber: inv.number })}
                          {" · "}
                          {t("received", { qty: `${formatNumber(it.receivedQtyBase / unit.factor, { locale, maximumFractionDigits: 3 })} ${unit.symbol}` })}
                        </div>
                      </div>
                      <label className="min-w-0">
                        <span className="sr-only">{t("returnQtyLabel", { name: it.ingredient.name })}</span>
                        <div className="flex items-center gap-1">
                          <input
                            inputMode="decimal"
                            value={l?.qty ?? ""}
                            onChange={(e) => setReturnQty(it.id, sanitizeDecimalInput(e.target.value), unitCost, unit.factor)}
                            className="w-full min-h-[40px] px-2 rounded-lg border border-op-border bg-op-bg text-sm text-right"
                            placeholder="0"
                          />
                          <span className="text-[11px] text-op-muted">{unit.symbol}</span>
                        </div>
                      </label>
                      <label className="min-w-0">
                        <span className="sr-only">{t("returnValueLabel", { name: it.ingredient.name })}</span>
                        <MoneyInput
                          value={l?.value ?? ""}
                          onChange={(v) => setReturnLines((prev) => (prev[it.id] ? { ...prev, [it.id]: { ...prev[it.id]!, value: v } } : prev))}
                          fractionDigits={2}
                          disabled={!l}
                          className="w-full min-h-[40px] px-2 rounded-lg border border-op-border bg-op-bg text-sm text-right disabled:opacity-50"
                          ariaLabel={t("returnValueLabel", { name: it.ingredient.name })}
                        />
                      </label>
                    </div>
                  );
                })}
              </div>
            )}
            <p className="mt-1 text-[11px] text-op-muted">{t("returnHint")}</p>
          </div>
        )}

        {/* Valor e impuestos */}
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="min-w-0">
            <span className={label}>{t(kind === "return" ? "fieldTotalReturn" : "fieldTotal")}</span>
            {kind === "return" ? (
              <div className={field + " flex items-center tabular-nums bg-op-surface"}>{money(totalCents)}</div>
            ) : (
              <MoneyInput
                value={total}
                onChange={(v) => {
                  setTotal(v);
                  if (hasTax && ivaPct > 0) setIva(centsToMajor(embeddedIva(majorToCents(v), majorToCents(inc), ivaPct)));
                }}
                fractionDigits={2}
                className={field + " text-right"}
                ariaLabel={t("fieldTotal")}
              />
            )}
          </label>
          <label className="flex items-center gap-2 min-h-[44px] sm:mt-5 text-sm">
            <input type="checkbox" checked={hasTax} onChange={(e) => setHasTax(e.target.checked)} className="h-5 w-5" />
            {t("fieldHasTax")}
          </label>
        </div>
        {!hasTax && <p className="mt-1 text-[11px] text-op-muted">{t("noTaxHint")}</p>}
        {hasTax && (
          <div className="mt-3 grid grid-cols-3 gap-3">
            <label className="min-w-0">
              <span className={label}>{t("fieldIvaPct")}</span>
              <select
                value={ivaPct}
                onChange={(e) => {
                  const pct = Number(e.target.value);
                  setIvaPct(pct);
                  if (kind !== "return") setIva(centsToMajor(embeddedIva(totalCents, incCents, pct)));
                }}
                className={field}
              >
                {rates.map((r) => (
                  <option key={r} value={r}>
                    {`${r} %`}
                  </option>
                ))}
              </select>
            </label>
            <label className="min-w-0">
              <span className={label}>{t("fieldIva")}</span>
              <MoneyInput value={iva} onChange={setIva} fractionDigits={2} className={field + " text-right"} ariaLabel={t("fieldIva")} />
            </label>
            <label className="min-w-0">
              <span className={label}>{t("fieldInc")}</span>
              <MoneyInput value={inc} onChange={setInc} fractionDigits={2} className={field + " text-right"} ariaLabel={t("fieldInc")} />
            </label>
            <p className="col-span-3 text-[11px] text-op-muted">{t(ivaDeductible ? "taxHintDeductible" : "taxHintNonDeductible")}</p>
          </div>
        )}
        {amountErr && totalCents > 0 && <p className="mt-2 text-xs text-danger">{t(ERROR_KEYS[amountErr] ?? "errInvalid")}</p>}

        {/* Cuenta contable */}
        <details className="mt-4 rounded-xl border border-op-border px-3 py-2">
          <summary className="cursor-pointer text-sm">
            {t("accountSummary", { code: accountCode || defaultAccount, name: accountName(accountCode || defaultAccount) ?? "" })}
          </summary>
          {accountIsConfigurable(kind) ? (
            <label className="block mt-2">
              <span className={label}>{t("fieldAccount")}</span>
              <select value={accountCode} onChange={(e) => setAccountCode(e.target.value)} className={field}>
                <option value="">{t("accountDefault", { code: defaultAccount, name: accountName(defaultAccount) ?? "" })}</option>
                {(ctx?.accounts ?? []).filter((a) => a.code !== defaultAccount).map((a) => (
                  <option key={a.code} value={a.code}>{`${a.code} · ${a.name}`}</option>
                ))}
              </select>
            </label>
          ) : null}
          <p className="mt-2 text-[11px] text-op-muted">{t(`accountHint_${kind}`)}</p>
        </details>

        {/* Aplicación a las facturas */}
        {supplierId && ctx && totalCents > 0 && (
          <div className="mt-4 rounded-2xl border border-op-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium">{t("applyTitle")}</span>
              <div className="mp-seg p-[3px]!" role="group" aria-label={t("applyTitle")}>
                {(["auto", "manual", "none"] as const).map((m) => (
                  <button key={m} type="button" aria-pressed={mode === m} data-active={mode === m ? "true" : undefined} onClick={() => setMode(m)} className="mp-seg__i text-xs">
                    {t(`applyMode_${m}`)}
                  </button>
                ))}
              </div>
            </div>
            {payables.length === 0 ? (
              <p className="mt-2 text-xs text-op-muted">{t("applyNothingPending")}</p>
            ) : mode === "manual" ? (
              <div className="mt-2 border border-op-border rounded-xl overflow-hidden">
                {payables.map((d) => (
                  <div key={payableKey(d)} className="grid grid-cols-[minmax(0,1fr)_8rem] gap-2 items-center px-3 py-2 border-b border-op-border last:border-b-0">
                    <div className="min-w-0">
                      <div className="text-sm truncate">{docLabel(t, d)}</div>
                      <div className="text-[11px] text-op-muted">
                        {t("dueOn", { date: formatDate(`${d.dueDate}T12:00:00Z`, { locale, timeStyle: undefined }) })}
                        {" · "}
                        {t("owes", { amount: money(d.outstandingCents) })}
                      </div>
                    </div>
                    <MoneyInput
                      value={manual[payableKey(d)] ?? ""}
                      onChange={(v) => setManual((prev) => ({ ...prev, [payableKey(d)]: v }))}
                      fractionDigits={2}
                      className="w-full min-h-[40px] px-2 rounded-lg border border-op-border bg-op-bg text-sm text-right"
                      ariaLabel={t("applyAmountLabel", { doc: docLabel(t, d) })}
                    />
                  </div>
                ))}
              </div>
            ) : mode === "auto" ? (
              <div className="mt-2 border border-op-border rounded-xl overflow-hidden">
                {previewAllocation(plan, payables).map((d) => (
                  <div key={payableKey(d)} className="flex items-center justify-between gap-3 px-3 py-2 border-b border-op-border last:border-b-0 text-sm">
                    <div className="min-w-0">
                      <div className="truncate">{docLabel(t, d)}</div>
                      <div className="text-[11px] text-op-muted">{t("previewLine", { owes: money(d.outstandingCents), left: money(d.newOutstandingCents) })}</div>
                    </div>
                    <div className="tabular-nums font-medium shrink-0">{`− ${money(d.appliedCents)}`}</div>
                  </div>
                ))}
                {plan.length === 0 && <p className="px-3 py-2 text-xs text-op-muted">{t("applyNothingPending")}</p>}
              </div>
            ) : null}
            <div className="mt-2 flex flex-wrap justify-between gap-2 text-sm">
              <span>{t("appliedTotal", { amount: money(applied) })}</span>
              <span className={leftover > 0 ? "font-medium text-[#2F6B4F]" : "text-op-muted"}>
                {t("leftoverTotal", { amount: money(leftover) })}
              </span>
            </div>
            {leftover > 0 && <p className="mt-1 text-[11px] text-op-muted">{t("leftoverHint")}</p>}
            {manualErr && <p className="mt-1 text-xs text-danger">{t("errPlanTooMuch")}</p>}
          </div>
        )}

        <label className="block mt-4">
          <span className={label}>{t("fieldNote")}</span>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} className={field + " py-2"} />
        </label>

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
            {busy === "save" ? t("saving") : t("save")}
          </button>
        </div>
      </div>
    </div>
  );
}
