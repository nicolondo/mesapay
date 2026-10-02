"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useLocale, useTranslations } from "next-intl";
import { MoneyInput } from "@/components/MoneyInput";
import { formatDate, formatMoney } from "@/lib/format";
import type { Locale } from "@/i18n/config";
import type { CreditNoteDto, CreditNoteInput, CreditNoteInvoiceChoice, CreditNoteProposal, CreditNoteSource, CreditReason } from "@/lib/dian/creditNotes/types";

type Draft = Omit<CreditNoteInput, "requestId">;
type Review = { input: Draft; proposal: CreditNoteProposal; requestId: string };
const API = "/api/operator/credit-notes";
const inputClass = "w-full rounded-xl border border-op-border bg-op-bg px-3 py-2.5 text-sm";
const buttonClass = "mp-btn mp-btn--secondary mp-btn--sm";
const ERROR_ALIASES: Record<string, string> = { accepted_invoice_required: "original_not_accepted", cancellation_requires_full_invoice: "reason_total_only", amount_exceeds_remaining: "credit_exceeds_balance", idempotency_conflict: "request_conflict", empty_credit: "no_balance", invalid_lines: "invalid", amount_too_large: "invalid", amount_too_small: "amount_too_small", dian_not_configured: "configuration", environment_mismatch: "configuration", invalid_credit_prefix: "configuration", numbering_exhausted: "configuration", budget_inconsistent: "source_unsupported", series_cannot_rewind: "series_cannot_rewind", issuer_mismatch: "configuration", no_config: "configuration", no_certificate: "configuration", missing_credentials: "configuration", master_key_missing: "configuration", decrypt_failed: "configuration", file_name_missing: "incomplete_document", file_numbering_exhausted: "configuration", no_recipient: "no_recipient" };
const ERROR_CODES = new Set(["source_changed", "balance_changed", "source_unsupported", "original_not_accepted", "no_balance", "invalid", "forbidden", "module_disabled", "reason_total_only", "cannot_abandon", "request_conflict", "credit_exceeds_balance", "amount_too_small", "configuration", "series_cannot_rewind", "transport_error", "certificate_expired", "test_set_missing", "issuer_changed", "environment_changed", "response_identifier_mismatch", "numbering_conflict", "incomplete_document", "no_recipient", "send_failed", "email_in_progress"]);

async function api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${API}${path}`, body === undefined ? { signal, cache: "no-store" } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.error ?? "request_failed");
  if (!result) throw new Error("request_failed");
  return result as T;
}

export function CreditNotesClient() {
  const t = useTranslations("opCreditNotes");
  const locale = useLocale() as Locale;
  const money = (cents: number) => formatMoney(cents, { currency: "COP", locale, fractionDigits: 2 });
  const date = (value: string) => formatDate(value, { locale });
  const [series, setSeries] = useState<{ prefix: string; nextNumber: number; environment: string; issuerNit: string } | null>(null);
  const [seriesPrefix, setSeriesPrefix] = useState("");
  const [seriesNext, setSeriesNext] = useState("");
  const [notes, setNotes] = useState<CreditNoteDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [invoices, setInvoices] = useState<CreditNoteInvoiceChoice[]>([]);
  const [searched, setSearched] = useState(false);
  const [source, setSource] = useState<CreditNoteSource | null>(null);
  const [mode, setMode] = useState<"total" | "partial">("total");
  const [reasonCode, setReasonCode] = useState<CreditReason>("2");
  const [reasonText, setReasonText] = useState("");
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [review, setReview] = useState<Review | null>(null);
  const [createAttempted, setCreateAttempted] = useState(false);
  const [detail, setDetail] = useState<CreditNoteDto | null>(null);
  const [abandonConfirm, setAbandonConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const detailHeading = useRef<HTMLHeadingElement>(null);

  const errorText = (err: unknown) => {
    const originalCode = err instanceof Error ? err.message : "request_failed";
    const code = ERROR_ALIASES[originalCode] ?? originalCode;
    return t(ERROR_CODES.has(code) ? `error_${code}` : "error_request_failed");
  };
  async function refresh() { setNotes((await api<{ notes: CreditNoteDto[] }>("")).notes); }
  useEffect(() => {
    const abort = new AbortController();
    api<{ notes: CreditNoteDto[] }>("", undefined, abort.signal).then(data => setNotes(data.notes)).catch(err => { if (!abort.signal.aborted) setError(errorText(err)); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
    // The page is keyed to the active restaurant by the operator layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { if (review) reviewHeading.current?.focus(); }, [review]);
  useEffect(() => { if (detail) detailHeading.current?.focus(); }, [detail]);

  async function run(action: string, work: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(action); setError(null); setNotice(null);
    try { await work(); } catch (err) { setError(errorText(err)); }
    finally { busyRef.current = false; setBusy(null); }
  }
  async function openSeries() {
    await run("series", async () => {
      const data = await api<{ series: NonNullable<typeof series> }>("/series");
      setSeries(data.series); setSeriesPrefix(data.series.prefix); setSeriesNext(String(data.series.nextNumber));
    });
  }
  async function saveSeries() {
    const nextNumber = Number(seriesNext);
    if (!/^[A-Z0-9]{1,10}$/.test(seriesPrefix.trim()) || !Number.isSafeInteger(nextNumber) || nextNumber < 1) { setError(t("seriesInvalid")); return; }
    await run("series-save", async () => {
      const data = await api<{ series: NonNullable<typeof series> }>("/series", { prefix: seriesPrefix.trim(), nextNumber });
      setSeries(data.series); setSeriesPrefix(data.series.prefix); setSeriesNext(String(data.series.nextNumber)); setSource(null); setReview(null); setNotice(t("seriesSaved"));
    });
  }
  async function search() {
    await run("search", async () => { const data = await api<{ invoices: CreditNoteInvoiceChoice[] }>(`/invoices?search=${encodeURIComponent(query.trim())}`); setInvoices(data.invoices); setSearched(true); });
  }
  async function selectInvoice(id: string) {
    await run("source", async () => {
      const data = await api<{ source: CreditNoteSource }>(`/source/${encodeURIComponent(id)}`);
      setSource(data.source); setReview(null); setAmounts({}); setReasonText(""); setMode("total"); setReasonCode(data.source.notes.some(note => !note.abandonedAt) ? "3" : "2");
    });
  }
  async function preview() {
    if (!source) return;
    if (reasonText.trim().length < 3) { setError(t("explanationRequired")); return; }
    const lines = source.lines.map(line => ({ lineId: line.lineId, grossCents: Math.round(Number(amounts[line.lineId] || 0) * 100) })).filter(line => line.grossCents > 0);
    if (mode === "partial" && (!lines.length || lines.some(line => !Number.isSafeInteger(line.grossCents) || line.grossCents > (source.lines.find(item => item.lineId === line.lineId)?.remainingGrossCents ?? 0)))) { setError(t("amountInvalid")); return; }
    const input: Draft = { originalInvoiceId: source.originalInvoiceId, sourceVersion: source.sourceVersion, mode, reasonCode, reasonText: reasonText.trim(), ...(mode === "partial" ? { lines } : {}) };
    await run("preview", async () => {
      try {
        const { proposal } = await api<{ proposal: CreditNoteProposal }>("/preview", input);
        setCreateAttempted(false); setReview({ input, proposal, requestId: crypto.randomUUID() });
      } catch (err) {
        if (err instanceof Error && ["source_changed", "balance_changed"].includes(err.message)) {
          setSource((await api<{ source: CreditNoteSource }>(`/source/${encodeURIComponent(source.originalInvoiceId)}`)).source); setReview(null);
        }
        throw err;
      }
    });
  }
  async function confirm() {
    if (!review) return;
    await run("create", async () => {
      setCreateAttempted(true);
      let note: CreditNoteDto;
      try { note = (await api<{ creditNote: CreditNoteDto }>("", { ...review.input, requestId: review.requestId })).creditNote; }
      catch (err) {
        if (err instanceof Error && ["source_changed", "balance_changed"].includes(err.message)) { setReview(null); if (source) setSource((await api<{ source: CreditNoteSource }>(`/source/${encodeURIComponent(source.originalInvoiceId)}`)).source); }
        throw err;
      }
      // Creation is now durable. Never create a second note if emission fails.
      setReview(null); setSource(null); setDetail(note); setNotes(previous => [note, ...previous.filter(item => item.id !== note.id)]);
      try { if (note.canRetry) await api(`/${note.id}/emit`, {}); setNotice(t("updated")); }
      finally { await loadDetail(note.id); await refresh(); }
    });
  }
  async function loadDetail(id: string) { setDetail((await api<{ creditNote: CreditNoteDto }>(`/${encodeURIComponent(id)}`)).creditNote); }
  async function action(note: CreditNoteDto, verb: string) {
    await run(`${note.id}:${verb}`, async () => { await api(`/${encodeURIComponent(note.id)}/${verb}`, {}); setAbandonConfirm(null); await loadDetail(note.id); await refresh(); setNotice(t(verb === "resend-email" ? "emailSent" : verb === "abandon" ? "abandonedNotice" : "updated")); });
  }
  const state = (note: CreditNoteDto) => note.abandonedAt ? "abandoned" : note.document?.state ?? "draft";
  const stateLabel = (note: CreditNoteDto) => t(`state_${["draft", "to_send", "pending", "signed", "sent", "accepted", "rejected", "error", "abandoned"].includes(state(note)) ? state(note) : "pending"}`);

  return <div className="mx-auto w-full max-w-5xl p-4 md:p-6 space-y-6">
    <header><Link href="/operator/facturas" className="text-sm text-op-muted hover:underline">{t("back")}</Link><h1 className="font-display text-3xl mt-3">{t("title")}</h1><p className="text-sm text-op-muted mt-2">{t("intro")}</p></header>
    {error && <div role="alert" className="rounded-xl border border-danger/30 bg-danger/5 p-4 text-sm text-danger">{error}</div>}
    {notice && <p role="status" className="rounded-xl bg-ok/10 p-4 text-sm">{notice}</p>}
    <section className="rounded-2xl border border-op-border bg-op-surface p-4 md:p-5" aria-labelledby="credit-series-title">
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="credit-series-title" className="font-display text-xl">{t("seriesTitle")}</h2><button type="button" className={buttonClass} disabled={!!busy || !!review} aria-expanded={!!series} aria-controls="credit-series-fields" onClick={() => series ? setSeries(null) : void openSeries()}>{t(series ? "seriesClose" : "seriesOpen")}</button></div>
      {series && <div id="credit-series-fields" className="mt-4 space-y-3"><p className="text-sm text-op-muted">{t("seriesHint")}</p><p className="text-xs text-op-muted">{t("seriesIssuer", { nit: series.issuerNit })}</p><div className="grid gap-3 sm:grid-cols-2"><div><label htmlFor="credit-series-prefix" className="block text-sm mb-1">{t("seriesPrefix")}</label><input id="credit-series-prefix" className={inputClass} value={seriesPrefix} onChange={event => setSeriesPrefix(event.target.value.toUpperCase())} maxLength={10} autoCapitalize="characters" disabled={!!busy || !!review} /></div><div><label htmlFor="credit-series-number" className="block text-sm mb-1">{t("seriesNext")}</label><input id="credit-series-number" type="number" inputMode="numeric" min={1} step={1} className={inputClass} value={seriesNext} onChange={event => setSeriesNext(event.target.value)} disabled={!!busy || !!review} /></div></div><button type="button" className={buttonClass} disabled={!!busy || !!review || (seriesPrefix === series.prefix && seriesNext === String(series.nextNumber))} onClick={() => void saveSeries()}>{t("seriesSave")}</button></div>}
    </section>
    <section className="rounded-2xl border border-op-border bg-op-surface p-4 md:p-5" aria-labelledby="credit-search-title">
      <h2 id="credit-search-title" className="font-display text-xl">{t("createTitle")}</h2>
      <p className="text-sm text-op-muted mt-1 mb-4">{t("searchHint")}</p>
      <form onSubmit={event => { event.preventDefault(); void search(); }} className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 basis-60"><label htmlFor="credit-invoice-search" className="block text-sm mb-1">{t("searchLabel")}</label><input id="credit-invoice-search" placeholder={t("searchPlaceholder")} value={query} onChange={event => setQuery(event.target.value)} maxLength={120} className={inputClass} disabled={!!busy || !!review} /></div>
        <button type="submit" disabled={!!busy || !!review} className={buttonClass}>{busy === "search" ? t("loading") : t("search")}</button>
      </form>
      {searched && <div className="mt-4"><p role="status" className="text-sm text-op-muted mb-2">{t(invoices.length ? "results" : "noInvoices", { count: invoices.length })}</p><ul className="divide-y divide-op-border">{invoices.map(invoice => <li key={invoice.id} className="flex flex-wrap items-center justify-between gap-3 py-3"><div className="min-w-0"><p className="font-semibold break-words">{invoice.invoiceNumber}</p><p className="text-sm text-op-muted break-words">{invoice.customerName || t("finalConsumer")}</p><p className="text-sm">{money(invoice.totalCents)}</p></div><button type="button" className={buttonClass} disabled={!!busy || !!review} onClick={() => void selectInvoice(invoice.id)} aria-label={t("selectInvoice", { number: invoice.invoiceNumber })}>{t("select")}</button></li>)}</ul></div>}
    </section>
    {source && !review && <section className="rounded-2xl border border-op-border bg-op-surface p-4 md:p-5 space-y-4" aria-labelledby="credit-adjust-title">
      <h2 id="credit-adjust-title" className="font-display text-xl">{t("adjustTitle", { number: source.original.invoiceNumber })}</h2>
      <p className="text-sm break-words">{[source.original.customer?.name, source.original.customer?.companyId].filter(Boolean).join(" · ")}</p>
      <p className="text-sm">{t("available", { amount: money(source.remainingTotalCents) })}</p>
      <p className="text-sm text-op-muted">{t("separateRefund")}</p>
      <fieldset disabled={!!busy} className="space-y-3"><legend className="text-sm font-semibold mb-2">{t("mode")}</legend>
        {(["total", "partial"] as const).map(value => <label key={value} className="flex items-start gap-3 rounded-xl border border-op-border p-3 cursor-pointer"><input type="radio" name="credit-mode" value={value} checked={mode === value} onChange={() => { setMode(value); if (value === "partial" && reasonCode === "2") setReasonCode("1"); }} className="mt-1" /><span><span className="block font-medium text-sm">{t(`mode_${value}`)}</span><span className="block text-xs text-op-muted">{t(`mode_${value}_hint`)}</span></span></label>)}
      </fieldset>
      {mode === "partial" && <div className="space-y-3">{source.lines.map(line => <div key={line.lineId} className="rounded-xl border border-op-border p-3"><label htmlFor={`credit-line-${line.lineId}`} className="block text-sm font-medium break-words">{line.description}</label><p className="text-xs text-op-muted my-1">{t("lineAvailable", { amount: money(line.remainingGrossCents) })}</p><MoneyInput id={`credit-line-${line.lineId}`} value={amounts[line.lineId] ?? ""} onChange={raw => setAmounts(previous => ({ ...previous, [line.lineId]: raw }))} fractionDigits={2} disabled={!!busy || line.remainingGrossCents <= 0} className={inputClass} ariaLabel={t("lineAmount", { name: line.description })} /></div>)}</div>}
      <div><label htmlFor="credit-reason" className="block text-sm font-semibold mb-1">{t("reason")}</label><select id="credit-reason" className={inputClass} value={reasonCode} disabled={!!busy} onChange={event => setReasonCode(event.target.value as CreditReason)}>{(["1", "2", "3", "4", "5", "6"] as const).map(code => <option key={code} value={code} disabled={code === "2" && (mode === "partial" || source.notes.some(note => !note.abandonedAt))}>{t(`reason_${code}`)}</option>)}</select></div>
      <div><label htmlFor="credit-explanation" className="block text-sm font-semibold mb-1">{t("explanation")}</label><textarea id="credit-explanation" className={inputClass} rows={3} minLength={3} maxLength={500} required value={reasonText} onChange={event => setReasonText(event.target.value)} disabled={!!busy} /></div>
      <button type="button" className="mp-btn mp-btn--primary" disabled={!!busy || source.remainingTotalCents <= 0 || reasonText.trim().length < 3} onClick={() => void preview()}>{busy === "preview" ? t("loading") : t("review")}</button>
    </section>}
    {review && source && <section className="rounded-2xl border-2 border-op-text bg-op-surface p-4 md:p-5 space-y-4" aria-labelledby="credit-review-title"><h2 ref={reviewHeading} tabIndex={-1} id="credit-review-title" className="font-display text-2xl outline-none">{t("reviewTitle")}</h2><p className="text-sm">{t("reviewOriginal", { number: source.original.invoiceNumber })}</p><p className="text-sm break-words">{[source.original.customer?.name, source.original.customer?.companyId].filter(Boolean).join(" · ")}</p><p className="text-sm">{t(`reason_${review.input.reasonCode}`)}</p><p className="whitespace-pre-wrap break-words text-sm">{review.input.reasonText}</p><div className="space-y-3">{review.proposal.lines.map(line => <div key={line.originalLineId} className="border-b border-op-border pb-3"><p className="font-medium break-words">{line.description}</p><dl className="mt-1 grid grid-cols-2 gap-x-3 text-sm"><dt>{t("base")}</dt><dd className="text-right tabular-nums">{money(line.lineTotalCents)}</dd><dt>{t("tax")}</dt><dd className="text-right tabular-nums">{money(line.taxCents)}</dd><dt>{t("total")}</dt><dd className="text-right tabular-nums">{money(line.grossCents)}</dd></dl></div>)}</div><dl className="grid grid-cols-2 gap-2 text-sm"><dt>{t("base")}</dt><dd className="text-right tabular-nums">{money(review.proposal.subtotalCents)}</dd><dt>{t("tax")}</dt><dd className="text-right tabular-nums">{money(review.proposal.taxCents)}</dd><dt className="font-bold text-lg">{t("creditTotal")}</dt><dd className="text-right font-bold text-lg tabular-nums">{money(review.proposal.totalCents)}</dd></dl><p className="text-sm text-op-muted">{t("separateRefund")}</p><p className="text-xs text-op-muted">{t("reviewWarning")}</p>{createAttempted && <p role="status" className="text-sm">{t("uncertainCreate")}</p>}<div className="flex flex-wrap gap-3"><button type="button" disabled={!!busy || createAttempted} className={buttonClass} onClick={() => setReview(null)}>{t("edit")}</button><button type="button" className="mp-btn mp-btn--primary" disabled={!!busy} onClick={() => void confirm()}>{busy === "create" ? t("sending") : t("confirm")}</button></div></section>}
    <section aria-labelledby="credit-list-title"><div className="flex flex-wrap items-center justify-between gap-3 mb-3"><h2 id="credit-list-title" className="font-display text-2xl">{t("history")}</h2><button className={buttonClass} type="button" disabled={!!busy} onClick={() => void run("refresh", refresh)}>{t("refresh")}</button></div>{loading ? <p role="status">{t("loading")}</p> : notes.length === 0 ? <p className="text-sm text-op-muted">{t("empty")}</p> : <ul className="space-y-3">{notes.map(note => <li key={note.id} className="rounded-xl border border-op-border bg-op-surface p-4 flex flex-wrap justify-between gap-3"><div className="min-w-0"><p className="font-semibold break-words">{note.documentNumber}</p><p className="text-sm text-op-muted break-words">{t("original", { number: note.snapshot.original.invoiceNumber })}</p><p className="text-xs text-op-muted">{date(note.createdAt)}</p><p className="mt-1 tabular-nums">{money(note.totalCents)}</p></div><div className="flex flex-col items-end gap-2"><span className="rounded-full bg-op-bg border border-op-border px-3 py-1 text-xs">{stateLabel(note)}</span><button className={buttonClass} type="button" disabled={!!busy} onClick={() => void run("detail", () => loadDetail(note.id))} aria-label={t("detailNote", { number: note.documentNumber })}>{t("detail")}</button></div></li>)}</ul>}</section>
    {detail && <section className="rounded-2xl border border-op-border bg-op-surface p-4 md:p-5 space-y-4" aria-labelledby="credit-detail-title"><div className="flex flex-wrap justify-between gap-3"><h2 ref={detailHeading} tabIndex={-1} id="credit-detail-title" className="font-display text-2xl outline-none">{detail.documentNumber}</h2><button type="button" className={buttonClass} disabled={!!busy} onClick={() => { setDetail(null); setAbandonConfirm(null); }}>{t("close")}</button></div><p>{stateLabel(detail)}</p><p className="text-sm">{t("original", { number: detail.snapshot.original.invoiceNumber })}</p><p className="text-xl tabular-nums">{money(detail.totalCents)}</p><p className="text-sm break-words">{[detail.snapshot.original.customer?.name, detail.snapshot.original.customer?.companyId].filter(Boolean).join(" · ")}</p><p className="text-sm whitespace-pre-wrap break-words">{detail.reasonText}</p><ul className="divide-y divide-op-border">{detail.snapshot.lines.map(line => <li key={line.originalLineId} className="flex justify-between gap-3 py-2 text-sm"><span className="min-w-0 break-words">{line.description}</span><span className="shrink-0 tabular-nums">{money(line.grossCents)}</span></li>)}</ul><dl className="grid grid-cols-2 gap-2 text-sm"><dt>{t("base")}</dt><dd className="text-right tabular-nums">{money(detail.subtotalCents)}</dd><dt>{t("tax")}</dt><dd className="text-right tabular-nums">{money(detail.taxCents)}</dd></dl>
      {!!detail.document?.errors.length && <div role="alert" className="text-sm text-danger"><p className="font-semibold">{t("dianErrors")}</p><ul className="list-disc pl-5 space-y-1">{detail.document.errors.map((error, index) => <li key={index} className="break-words">{error}</li>)}</ul></div>}
      {detail.document?.emailError && <p role="alert" className="text-sm text-danger break-words">{detail.document.emailError}</p>}
      {detail.document?.lastError && <p role="alert" className="text-sm text-danger break-words">{detail.document.lastError}</p>}
      {state(detail) === "accepted" && detail.document?.cufe && <div className="space-y-2"><p className="text-sm font-semibold">{t("cude")}</p><p className="break-all font-mono text-xs">{detail.document.cufe}</p><Image unoptimized src={`${API}/${detail.id}/qr`} width={180} height={180} alt={t("qrAlt")} className="h-44 w-44 max-w-full" /><a href={`https://${detail.environment === "2" ? "catalogo-vpfe-hab" : "catalogo-vpfe"}.dian.gov.co/document/searchqr?documentkey=${encodeURIComponent(detail.document.cufe)}`} target="_blank" rel="noopener noreferrer" className="text-sm underline">{t("verifyDian")}</a></div>}
      <div className="flex flex-wrap gap-2">
        {state(detail) === "accepted" && <><a className={buttonClass} href={`${API}/${detail.id}/download?format=pdf`}>{t("downloadPdf")}</a><a className={buttonClass} href={`${API}/${detail.id}/download?format=xml`}>{t("downloadXml")}</a><a className={buttonClass} href={`${API}/${detail.id}/print`} target="_blank" rel="noopener noreferrer">{t("print")}</a><button type="button" className={buttonClass} disabled={!!busy || !detail.snapshot.recipientEmail} onClick={() => void action(detail, "resend-email")}>{t("resendEmail")}</button></>}
        {!detail.abandonedAt && ["pending", "sent", "error"].includes(state(detail)) && <button type="button" className={buttonClass} disabled={!!busy} onClick={() => void action(detail, "status")}>{t("checkStatus")}</button>}
        {detail.canRetry && <button type="button" className={buttonClass} disabled={!!busy} onClick={() => void action(detail, "emit")}>{t("retry")}</button>}
        {detail.canAbandon && <button type="button" className={buttonClass} disabled={!!busy} onClick={() => setAbandonConfirm(detail.id)}>{t("abandon")}</button>}
      </div>
      {state(detail) === "accepted" && <p className="text-xs text-op-muted break-words">{detail.snapshot.recipientEmail ? t("emailTo", { email: detail.snapshot.recipientEmail }) : t("noEmail")}{detail.document?.emailedAt ? ` · ${date(detail.document.emailedAt)}` : ""}</p>}
      {state(detail) === "accepted" && detail.document?.emailError && detail.document.emailError !== "no_recipient" && <p role="status" className="text-sm text-danger">{errorText(new Error(detail.document.emailError.startsWith("sending:") ? "email_in_progress" : detail.document.emailError))}</p>}
      {abandonConfirm === detail.id && <div role="group" aria-label={t("abandonTitle")} className="border border-danger/30 rounded-xl p-4 space-y-3"><p className="font-semibold">{t("abandonTitle")}</p><p className="text-sm">{t("abandonWarning")}</p><div className="flex flex-wrap gap-2"><button className={buttonClass} type="button" disabled={!!busy} onClick={() => setAbandonConfirm(null)}>{t("cancel")}</button><button className="mp-btn mp-btn--primary mp-btn--sm" type="button" disabled={!!busy} onClick={() => void action(detail, "abandon")}>{t("confirmAbandon")}</button></div></div>}
    </section>}
  </div>;
}
