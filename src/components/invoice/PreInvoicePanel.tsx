"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import {
  BrowserPrintStatus,
  browserPrintStateFrom,
  type BrowserPrintState,
} from "@/components/BrowserPrintStatus";
import { StaffPrintButton } from "@/components/print/StaffPrintButton";
import { InvoiceFormSheet } from "@/components/invoice/InvoiceFormSheet";
import { SimpleInvoiceSheet } from "@/components/invoice/SimpleInvoiceSheet";
import type { InvoiceIntent } from "@/components/invoice/types";
import { creditNotePreselectHref } from "@/lib/dian/creditNoteLink";
import { invoicePrintHref, printAsStaff } from "@/lib/print/staffPrint";

/**
 * FACTURA ANTES DE COBRAR — las dos piezas de pantalla del staff.
 *
 *   · `PreInvoiceAction`: el botón "Imprimir factura" de una cuenta abierta
 *     y su hoja (cliente de la factura, aviso de que la cuenta queda
 *     cerrada, "Emitir e imprimir"), con lo que pasó después: enviada a la
 *     impresora, impresa desde el navegador, o la DIAN todavía sin aceptarla
 *     (y entonces la precuenta para llevar mientras).
 *   · `InvoicedOrderBanner`: la cuenta YA facturada y pendiente de pago —
 *     número, estado DIAN, "Reimprimir factura", y qué se puede hacer
 *     (cobrar con cualquier medio; corregir sólo con nota crédito).
 *
 * La lógica vive en el servidor (`src/lib/preInvoice.ts`,
 * `POST/GET /api/operator/orders/[id]/pre-invoice`); acá sólo se cuenta.
 */

/** Lo que el servidor sabe de la factura de la cuenta (`OrderInvoiceView`). */
export type InvoicedOrderView = {
  invoiceId: string;
  documentNumber: string;
  issuedBeforePayment: boolean;
  dianState: string | null;
  dianLastError: string | null;
  annulled: boolean;
};

type DianStatus =
  | { state: "accepted" }
  | { state: "pending" }
  | { state: "blocked"; reason: string }
  | { state: "rejected"; reason: string | null }
  | { state: "error"; reason: string | null };

type PrintOutcome =
  | { queued: true; printerName: string }
  | { queued: false; reason: string };

type PreInvoiceResponse = {
  ok: true;
  invoiceId: string;
  documentNumber: string;
  alreadyIssued: boolean;
  einvoicing: boolean;
  dian: DianStatus | null;
  print: PrintOutcome;
};

type DianWord =
  | "dianStateAccepted"
  | "dianStatePending"
  | "dianStateBlocked"
  | "dianStateRejected"
  | "dianStateError";

/** El estado del documento DIAN guardado → la palabra de la pantalla. */
function dianWordOfDoc(state: string, lastError: string | null): DianWord {
  switch (state) {
    case "accepted":
      return "dianStateAccepted";
    case "rejected":
      return "dianStateRejected";
    case "error":
      return "dianStateError";
    case "to_send":
      return lastError ? "dianStateBlocked" : "dianStatePending";
    default:
      return "dianStatePending";
  }
}

/** Lo que contestó `GET …/pre-invoice` → la palabra de la pantalla. */
function dianWordOfStatus(s: DianStatus): DianWord {
  switch (s.state) {
    case "accepted":
      return "dianStateAccepted";
    case "blocked":
      return "dianStateBlocked";
    case "rejected":
      return "dianStateRejected";
    case "error":
      return "dianStateError";
    default:
      return "dianStatePending";
  }
}

export function PreInvoiceAction({
  orderId,
  tenantSlug,
  totalLabel,
  initialIntent = null,
  prefillEmail = null,
  sameTab = false,
  canConfigurePrinters = false,
  onPrintPrebill,
  onIssued,
  suggestedTipPct = null,
  manualInvoice = false,
  className = "mp-btn mp-btn--secondary mp-btn--block",
}: {
  orderId: string;
  tenantSlug: string;
  /** Lo que se va a facturar, ya formateado en la moneda del comercio. */
  totalLabel: string;
  /** Lo que ya se pidió en la cuenta (factura personalizada / correo). */
  initialIntent?: InvoiceIntent | null;
  prefillEmail?: string | null;
  /** PWA del mesero: los respaldos navegan in-app. */
  sameTab?: boolean;
  canConfigurePrinters?: boolean;
  /** Imprime la precuenta (mientras la DIAN no acepta la factura). */
  onPrintPrebill?: () => void;
  /** La factura quedó emitida: el padre refresca la cuenta. */
  onIssued?: (invoice: { invoiceId: string; documentNumber: string }) => void;
  /**
   * La propina elegida en el cobro (0 = «Sin propina»): la factura la
   * guarda y, con 0, ninguna representación sugiere propina. null = sin
   * selector (la ficha de la mesa): la sugerida de siempre.
   */
  suggestedTipPct?: number | null;
  /**
   * Cuenta de una FACTURA MANUAL (mesa `kind = manual`): su botón tiene
   * rótulo propio (`actionManual`), que conecta el flujo de las manuales.
   */
  manualInvoice?: boolean;
  className?: string;
}) {
  const t = useTranslations("preInvoice");
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"confirm" | "formal" | "simple">("confirm");
  const [intent, setIntent] = useState<InvoiceIntent | null>(initialIntent);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PreInvoiceResponse | null>(null);
  const [browser, setBrowser] = useState<BrowserPrintState | null>(null);
  const [browserReason, setBrowserReason] = useState<"no_printer" | "agent_offline" | null>(null);
  const [checking, setChecking] = useState(false);

  function openSheet() {
    setOpen(true);
    setStep("confirm");
    setError(null);
  }

  function close() {
    setOpen(false);
    // Ya emitida: el padre (la ficha) pasa a mostrar la cuenta facturada.
    if (result) onIssued?.({ invoiceId: result.invoiceId, documentNumber: result.documentNumber });
  }

  /** Sin impresora (o con el agente caído): la vista de la factura, acá. */
  async function printInBrowser(invoiceId: string) {
    const result = await printAsStaff(
      { kind: "invoice", orderId, href: invoicePrintHref({ invoiceId }) },
      {
        onBrowserFallback: (reason) => {
          setBrowserReason(reason);
          setBrowser({ step: "preparing" });
        },
      },
    );
    if (result.via === "browser") setBrowser(browserPrintStateFrom(result.outcome, result.tabUrl));
    else setBrowser(null);
  }

  async function issue() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setBrowser(null);
    try {
      const res = await fetch(`/api/operator/orders/${orderId}/pre-invoice`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(suggestedTipPct == null ? {} : { suggestedTipPct }),
      });
      const j = (await res.json().catch(() => ({}))) as Partial<PreInvoiceResponse> & { error?: string };
      if (!res.ok || !j.ok) {
        setError(
          j.error === "not_billable"
            ? t("errorNotBillable")
            : j.error === "order_closed"
              ? t("errorClosed")
              : j.error === "numbering_exhausted"
                ? t("errorNumbering")
                : t("errorGeneric"),
        );
        return;
      }
      const r = j as PreInvoiceResponse;
      setResult(r);
      if (!r.print.queued && (r.print.reason === "no_printer" || r.print.reason === "agent_offline")) {
        await printInBrowser(r.invoiceId);
      }
    } catch {
      setError(t("errorGeneric"));
    } finally {
      setBusy(false);
    }
  }

  /** "¿Ya la aceptó la DIAN?" — sin emitir nada. */
  async function checkAgain() {
    if (!result || checking) return;
    setChecking(true);
    try {
      const res = await fetch(`/api/operator/orders/${orderId}/pre-invoice`);
      if (!res.ok) return;
      const j = (await res.json()) as { dian: DianStatus | null };
      setResult({ ...result, dian: j.dian });
    } finally {
      setChecking(false);
    }
  }

  const resultText = (() => {
    if (!result) return null;
    const number = result.documentNumber;
    const dian = result.dian;
    if (result.einvoicing && dian && dian.state !== "accepted") {
      if (dian.state === "blocked") return t("dianBlocked", { number });
      if (dian.state === "rejected") return t("dianRejected", { number });
      if (dian.state === "error") return t("dianError", { number });
      return t("dianPending", { number });
    }
    if (result.print.queued) {
      return result.print.printerName
        ? t("resultSent", { number, printer: result.print.printerName })
        : t("resultSentNoName", { number });
    }
    if (result.print.reason === "duplicate") return t("resultDuplicate", { number });
    if (result.print.reason === "no_printer" || result.print.reason === "agent_offline") {
      return t("resultBrowser", { number });
    }
    return t("resultIssued", { number });
  })();
  const waitingDian =
    !!result && result.einvoicing && !!result.dian && result.dian.state !== "accepted";

  return (
    <>
      {/* «Emitir e imprimir factura»: el botón EMITE (no es una reimpresión). */}
      <button type="button" onClick={openSheet} className={className}>
        {manualInvoice ? t("actionManual") : t("action")}
      </button>

      {open && step === "confirm" && (
        <div
          // Sin cierre al tocar afuera: emitir la factura se decide con los botones de la hoja.
          className="fixed inset-0 z-[60] bg-ink/50 flex items-end md:items-center justify-center p-0 md:p-6"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t("sheetTitle")}
            className="w-full md:max-w-md bg-paper rounded-t-3xl md:rounded-3xl border border-hairline p-5 space-y-4 max-h-[90dvh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-muted">
                  {t("sheetLabel")}
                </div>
                <h2 className="font-display text-2xl mt-1">
                  {result ? result.documentNumber : t("sheetTitle")}
                </h2>
              </div>
              <button
                type="button"
                onClick={close}
                disabled={busy}
                className="text-muted text-sm shrink-0"
                aria-label={t("close")}
              >
                {"✕"}
              </button>
            </div>

            {!result ? (
              <>
                <p className="text-sm text-ink/80">{t("sheetIntro", { total: totalLabel })}</p>

                <div className="rounded-xl border border-hairline bg-op-bg p-3 space-y-2">
                  <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
                    {t("customerLabel")}
                  </div>
                  <div className="text-sm font-medium break-words">
                    {intent?.kind === "formal"
                      ? t("customerPerson", {
                          name: intent.summary.customerName,
                          doc: `${intent.summary.docType} ${intent.summary.docNumber}`,
                        })
                      : intent?.kind === "simple" && intent.email
                        ? t("customerGenericEmail", { email: intent.email })
                        : t("customerFinal")}
                  </div>
                  {!intent || (intent.kind === "simple" && !intent.email) ? (
                    <p className="text-xs text-op-muted">{t("customerFinalHint")}</p>
                  ) : null}
                  <div className="flex flex-wrap gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => setStep("formal")}
                      className="h-9 px-3 rounded-full border border-hairline text-xs font-medium hover:bg-ivory"
                    >
                      {intent?.kind === "formal" ? t("change") : t("toName")}
                    </button>
                    {intent?.kind !== "formal" && (
                      <button
                        type="button"
                        onClick={() => setStep("simple")}
                        className="h-9 px-3 rounded-full border border-hairline text-xs font-medium hover:bg-ivory"
                      >
                        {intent?.kind === "simple" && intent.email ? t("changeEmail") : t("addEmail")}
                      </button>
                    )}
                  </div>
                </div>

                <p className="text-xs leading-relaxed text-[#8F6828] bg-[#F6EEDD] rounded-xl p-3">
                  {t("lockWarning")}
                </p>

                {error && (
                  <p role="alert" className="text-sm text-danger">
                    {error}
                  </p>
                )}

                <div className="space-y-2">
                  <button
                    type="button"
                    onClick={issue}
                    disabled={busy}
                    className="w-full h-12 rounded-2xl bg-ink text-bone text-sm font-medium disabled:opacity-60"
                  >
                    {busy ? t("issuing") : t("confirm")}
                  </button>
                  <button
                    type="button"
                    onClick={close}
                    disabled={busy}
                    className="w-full h-11 rounded-2xl border border-hairline text-sm"
                  >
                    {t("cancel")}
                  </button>
                </div>
              </>
            ) : (
              <>
                <p role="status" className={"text-sm " + (waitingDian ? "text-[#8F6828]" : "text-[#1E5339]")}>
                  {resultText}
                  {browser && (
                    <>
                      {" "}
                      <BrowserPrintStatus
                        state={browser}
                        sameTab={sameTab}
                        setup={
                          browserReason === "no_printer"
                            ? canConfigurePrinters
                              ? "link"
                              : "ask"
                            : null
                        }
                      />
                    </>
                  )}
                </p>
                <p className="text-xs text-op-muted">{t("afterIssueHint")}</p>
                <div className="space-y-2">
                  {waitingDian && onPrintPrebill && (
                    <button
                      type="button"
                      onClick={() => {
                        // La precuenta cuenta su resultado en la ficha.
                        close();
                        onPrintPrebill();
                      }}
                      className="w-full h-12 rounded-2xl bg-ink text-bone text-sm font-medium"
                    >
                      {t("printPrebill")}
                    </button>
                  )}
                  {waitingDian && (
                    <button
                      type="button"
                      onClick={checkAgain}
                      disabled={checking}
                      className="w-full h-11 rounded-2xl border border-hairline text-sm disabled:opacity-60"
                    >
                      {checking ? t("checking") : t("checkAgain")}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={close}
                    className="w-full h-11 rounded-2xl border border-hairline text-sm"
                  >
                    {t("close")}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {open && step === "formal" && (
        <InvoiceFormSheet
          tenantSlug={tenantSlug}
          orderId={orderId}
          initial={intent?.kind === "formal" ? intent.summary : null}
          prefillEmail={intent?.kind === "simple" ? (intent.email ?? prefillEmail) : prefillEmail}
          beforePayment
          operatorMode
          closeOnSave
          onClose={() => setStep("confirm")}
          onSaved={(summary) => setIntent({ kind: "formal", summary })}
        />
      )}
      {open && step === "simple" && (
        <SimpleInvoiceSheet
          tenantSlug={tenantSlug}
          orderId={orderId}
          prefillEmail={intent?.kind === "simple" ? intent.email : prefillEmail}
          beforePayment
          operatorMode
          closeOnSave
          onClose={() => setStep("confirm")}
          onSaved={(email) => setIntent({ kind: "simple", email })}
        />
      )}
    </>
  );
}

/**
 * La cuenta ya facturada y pendiente de pago. `canAnnul`: quien mira puede
 * emitir notas crédito (administradores; el mesero no).
 */
export function InvoicedOrderBanner({
  orderId,
  invoice,
  sameTab = false,
  canConfigurePrinters = false,
  canAnnul = false,
  compact = false,
}: {
  orderId: string;
  invoice: InvoicedOrderView;
  sameTab?: boolean;
  canConfigurePrinters?: boolean;
  canAnnul?: boolean;
  /** En el cobro: sin la explicación larga de la cuenta cerrada. */
  compact?: boolean;
}) {
  const t = useTranslations("preInvoice");
  // null = comercio sin facturación electrónica (no hay documento DIAN).
  const docWord = invoice.dianState
    ? dianWordOfDoc(invoice.dianState, invoice.dianLastError)
    : null;
  const [checked, setChecked] = useState<{ from: DianWord | null; word: DianWord } | null>(null);
  // Lo consultado vale mientras el servidor no traiga otra cosa.
  const dianWord = checked && checked.from === docWord ? checked.word : docWord;
  const [checking, setChecking] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function checkDian() {
    if (checking) return;
    setChecking(true);
    try {
      const res = await fetch(`/api/operator/orders/${orderId}/pre-invoice`);
      if (!res.ok) return;
      const j = (await res.json()) as { dian: DianStatus | null };
      if (!mounted.current || !j.dian) return;
      setChecked({ from: docWord, word: dianWordOfStatus(j.dian) });
    } finally {
      if (mounted.current) setChecking(false);
    }
  }

  const accepted = dianWord === "dianStateAccepted";
  return (
    <div className="rounded-xl border border-[#C9A25A]/60 bg-[#F6EEDD] p-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-mono text-[10px] tracking-wider uppercase text-[#8F6828]">
            {invoice.annulled ? t("bannerAnnulled") : t("bannerLabel")}
          </div>
          <div className="text-sm font-medium mt-0.5">{invoice.documentNumber}</div>
          {dianWord && (
            <div className="font-mono text-[10px] text-op-muted mt-0.5">
              {t(dianWord)}
            </div>
          )}
        </div>
        <a
          href={invoicePrintHref({ invoiceId: invoice.invoiceId })}
          target={sameTab ? undefined : "_blank"}
          rel="noreferrer"
          className="shrink-0 text-xs underline text-op-text"
        >
          {t("view")}
        </a>
      </div>
      <p className="text-xs leading-relaxed text-ink/80">
        {invoice.annulled
          ? t("bannerAnnulledBody", { number: invoice.documentNumber })
          : compact
            ? t("bannerBodyCompact")
            : t("bannerBody")}
      </p>
      {!invoice.annulled && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {/* Con la DIAN sin aceptarla, "Reimprimir" saca el comprobante y lo
              dice (ver reprint-invoice): mejor primero consultar. */}
          {dianWord !== null && !accepted ? (
            <button
              type="button"
              onClick={checkDian}
              disabled={checking}
              className="h-9 px-3 rounded-full bg-ink text-bone text-xs font-medium disabled:opacity-60"
            >
              {checking ? t("checking") : t("checkAgain")}
            </button>
          ) : (
            <span className="inline-flex flex-col">
              <StaffPrintButton
                destinationVariant="pay"
                doc={{ kind: "invoice", orderId, href: invoicePrintHref({ invoiceId: invoice.invoiceId }) }}
                label={t("reprint")}
                sameTab={sameTab}
                canConfigurePrinters={canConfigurePrinters}
                className="h-9 px-3 rounded-full border border-hairline bg-paper text-xs font-medium disabled:opacity-60"
                statusClassName="block text-[11px] mt-1"
              />
            </span>
          )}
          {canAnnul && (
            <Link
              href={creditNotePreselectHref(invoice.invoiceId)}
              prefetch={false}
              className="text-xs underline text-op-muted hover:text-op-text"
            >
              {t("annulLink")}
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
