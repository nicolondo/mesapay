"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { AppDialog } from "@/components/ui/AppDialog";
import { CreditPaymentSheet } from "@/components/billingCustomers/CreditPaymentSheet";
import { formatDate, formatMoney } from "@/lib/format";
import type { Locale } from "@/i18n/config";
import type { ManualInvoiceSendInfo, PayLinkMethod, PayLinkView } from "./types";

/**
 * "EMITIR Y ENVIAR FACTURA" de una factura manual, a la mano donde se
 * trabaja: la ficha en Mesas (`variant="sheet"`), la ficha de la orden
 * (`variant="panel"`) y la fila de Órdenes (`ManualInvoiceSendButton`).
 *
 * El dueño: «necesito que la factura pueda quedar emitida para después
 * mandar el link de pago y que no quede activa pendiente de pago en las
 * mesas». La acción principal emite la factura a nombre del cliente
 * identificado, la manda por correo con el link de pago y saca la cuenta de
 * Mesas: queda por cobrar en Cartera hasta que el cliente pague (por el
 * link, o con un pago que se registre acá). Todo pasa por la misma API
 * (`POST /api/operator/orders/[id]/pay-link`) y el mismo link por orden: lo
 * que se copia, lo que va por WhatsApp y lo que llega por correo es igual.
 *
 * Los errores llegan como CÓDIGO y se traducen acá.
 */

const MAX_RECIPIENTS = 5;
const METHOD_KEY: Record<PayLinkMethod, string> = {
  kushki_card: "methodCard",
  kushki_apple_pay: "methodApplePay",
  kushki_pse: "methodPse",
  kushki_bre_b: "methodBreB",
};

type Mode = "issue" | "link" | "resend";

type ApiResponse = {
  url?: string;
  expiresAt?: string;
  sentTo?: string[];
  sentAt?: string | null;
  failed?: string[];
  issued?: boolean;
  emailFailed?: boolean;
  error?: string;
};

function useSendText() {
  const t = useTranslations("manualInvoiceSend");
  const locale = useLocale() as Locale;
  const day = (iso: string) => formatDate(iso, { locale, dateStyle: "long", timeStyle: undefined });
  const when = (iso: string) => formatDate(iso, { locale });
  const list = (items: readonly string[], type: "conjunction" | "disjunction" = "conjunction") =>
    new Intl.ListFormat(locale, { type }).format(items);
  const methodName = (m: string) => (m in METHOD_KEY ? t(METHOD_KEY[m as PayLinkMethod]) : m);
  function errorText(code: string | undefined): string {
    switch (code) {
      case "not_manual_invoice":
      case "order_closed":
      case "receivable_closed":
        return t("errClosed");
      case "nothing_to_pay":
        return t("errNothingToPay");
      case "online_payments_unavailable":
        return t("errOnlineUnavailable");
      case "customer_required":
        return t("errCustomerRequired");
      case "customer_invalid":
        return t("errCustomerInvalid");
      case "pending_payment_in_flight":
        return t("errInFlight");
      case "email_failed":
        return t("errEmail");
      case "invalid":
        return t("errInvalidEmail");
      default:
        return t("errGeneric");
    }
  }
  return { t, locale, day, when, list, methodName, errorText };
}

async function callPayLink(orderId: string, body: { emails?: string[]; issue?: boolean }): Promise<{ ok: boolean; data: ApiResponse }> {
  const res = await fetch(`/api/operator/orders/${encodeURIComponent(orderId)}/pay-link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as ApiResponse;
  return { ok: res.ok && !!data.url, data };
}

/** Las líneas de estado: emitida, por cobrar/vencida, enviada, abierta, pagada… */
export function PayLinkStatusLines({ info }: { info: ManualInvoiceSendInfo }) {
  const { t, locale, day, when, list, methodName } = useSendText();
  const money = (cents: number) => formatMoney(cents, { currency: info.currency, locale, fractionDigits: "auto" });
  const lines: { key: string; text: string; tone?: "ok" | "warn" | "muted" }[] = [];
  const r = info.receivable;
  const link = info.link;
  if (info.invoiceNumber) lines.push({ key: "issued", text: t("statusIssued", { number: info.invoiceNumber }) });
  if (link?.state === "paid" || (r && r.outstandingCents <= 0 && r.totalCents > 0)) {
    lines.push({
      key: "paid",
      tone: "ok",
      text:
        link?.paidMethod && link.paidAt
          ? t("statusPaidOnline", { method: methodName(link.paidMethod), date: when(link.paidAt) })
          : t("statusPaid"),
    });
  } else if (link?.state === "cancelled") {
    lines.push({ key: "cancelled", tone: "muted", text: t("statusCancelled") });
  } else if (r) {
    lines.push(
      r.overdue
        ? { key: "due", tone: "warn", text: t("statusOverdue", { amount: money(r.outstandingCents), date: day(r.dueDate) }) }
        : { key: "due", text: t("statusReceivable", { amount: money(r.outstandingCents), date: day(r.dueDate) }) },
    );
  }
  if (link) {
    lines.push(
      link.sentTo.length > 0 && link.sentAt
        ? { key: "sent", text: t("statusSent", { emails: list(link.sentTo), date: when(link.sentAt) }) }
        : { key: "sent", tone: "muted", text: t("statusNotSent") },
    );
    if (link.state === "open" || link.state === "expired") {
      lines.push(
        link.openedAt
          ? { key: "opened", text: t("statusOpened", { date: when(link.openedAt) }) }
          : { key: "opened", tone: "muted", text: t("statusNotOpened") },
      );
      lines.push(
        link.state === "expired"
          ? { key: "link", tone: "warn", text: t("statusLinkExpired", { date: day(link.expiresAt) }) }
          : { key: "link", tone: "muted", text: t("statusLinkOpen", { date: day(link.expiresAt) }) },
      );
    }
  }
  if (lines.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1 text-xs">
      {lines.map((l) => (
        <li
          key={l.key}
          className={
            l.tone === "ok"
              ? "text-[#1E5339] font-medium"
              : l.tone === "warn"
                ? "text-terracotta font-medium"
                : l.tone === "muted"
                  ? "text-op-muted"
                  : "text-op-text"
          }
        >
          {l.text}
        </li>
      ))}
    </ul>
  );
}

/**
 * La tarjeta completa: estado + acción principal + copiar / WhatsApp, y en
 * una factura por cobrar, "Registrar pago recibido" y "Ver en Cartera".
 */
export function ManualInvoiceSendCard({
  info,
  variant,
  customerName,
  customerEmail,
  afterIssue = "refresh",
}: {
  info: ManualInvoiceSendInfo;
  variant: "sheet" | "panel";
  /** Cliente identificado AHORA (la ficha lo actualiza sin esperar al server). */
  customerName?: string | null;
  customerEmail?: string | null;
  /** Qué hacer al emitir: refrescar (ficha de la orden) o ir a la ficha (Mesas: la cuenta se va de ahí). */
  afterIssue?: "refresh" | "open-order";
}) {
  const { t, locale, list, methodName, errorText } = useSendText();
  const router = useRouter();
  const money = (cents: number) => formatMoney(cents, { currency: info.currency, locale, fractionDigits: "auto" });
  const [mode, setMode] = useState<Mode | null>(null);
  const [payOpen, setPayOpen] = useState(false);
  const [busy, setBusy] = useState<"copy" | "whatsapp" | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  // El link que devolvió la última acción manda sobre el del server sólo
  // mientras el server no traiga uno nuevo (router.refresh).
  const [override, setOverride] = useState<{ base: PayLinkView | null; value: PayLinkView } | null>(null);
  const link = override && override.base === info.link ? override.value : info.link;

  const customer = customerName !== undefined ? customerName : info.customerName;
  const receivable = info.receivable;
  const settled = link?.state === "paid" || link?.state === "cancelled";
  const issuedLabel = info.invoiceNumber ? t("sendIssuedButton") : t("issueButton");
  const suggested = [
    ...(customerEmail ? [customerEmail.trim().toLowerCase()] : []),
    ...info.suggestedEmails,
  ].filter((e, i, all) => e && all.indexOf(e) === i);

  async function linkUrl(): Promise<string | null> {
    if (link && link.state === "open") return link.url;
    const { ok, data } = await callPayLink(info.orderId, {});
    if (!ok || !data.url) {
      setNotice({ ok: false, text: errorText(data.error) });
      return null;
    }
    setOverride({
      base: info.link,
      value: {
        url: data.url,
        expiresAt: data.expiresAt ?? link?.expiresAt ?? new Date().toISOString(),
        state: "open",
        sentTo: data.sentTo ?? link?.sentTo ?? [],
        sentAt: data.sentAt ?? link?.sentAt ?? null,
        openedAt: data.url === link?.url ? link.openedAt : null,
        paidMethod: null,
        paidAt: null,
      },
    });
    return data.url;
  }

  async function copy() {
    if (busy) return;
    setBusy("copy");
    setNotice(null);
    try {
      const url = await linkUrl();
      if (!url) return;
      try {
        await navigator.clipboard.writeText(url);
        setNotice({ ok: true, text: t("copied") });
      } catch {
        setNotice({ ok: false, text: t("copyFailed") });
      }
    } finally {
      setBusy(null);
    }
  }

  async function whatsapp() {
    if (busy) return;
    setBusy("whatsapp");
    setNotice(null);
    try {
      const url = await linkUrl();
      if (!url) return;
      const text = t(info.invoiceNumber ? "whatsappTextInvoice" : "whatsappText", {
        restaurant: info.tenantName,
        code: info.orderCode,
        number: info.invoiceNumber ?? "",
        amount: money(info.outstandingCents),
        url,
      });
      // Sin número: WhatsApp abre el selector de chat con el mensaje listo.
      window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank", "noopener,noreferrer");
    } finally {
      setBusy(null);
    }
  }

  const primary: { mode: Mode; label: string; disabled: boolean } | null = info.open
    ? { mode: "issue", label: issuedLabel, disabled: !info.canSend || !customer }
    : receivable && !settled && info.canSend
      ? { mode: "resend", label: t("resendButton"), disabled: false }
      : null;
  const showSecondary = !settled && info.canSend && (info.open || receivable);

  return (
    <section
      aria-label={t("sectionTitle")}
      className={
        variant === "sheet"
          ? "rounded-xl border border-terracotta/30 bg-terracotta/5 p-3"
          : "mt-4 bg-op-surface border border-op-border rounded-2xl p-4"
      }
    >
      <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">{t("sectionTitle")}</div>
      <p className="text-xs text-op-muted">
        {link?.state === "paid"
          ? t("introPaid")
          : link?.state === "cancelled"
            ? t("introCancelled")
            : receivable
              ? t("introReceivable")
              : t("introOpen")}
      </p>
      <PayLinkStatusLines info={{ ...info, link }} />

      {info.methods.length > 0 && !settled && (
        <p className="mt-2 text-[11px] text-op-muted">
          {t("methodsLabel", { list: list(info.methods.map((m) => methodName(m)), "conjunction") })}
        </p>
      )}

      {primary && (
        <div className="mt-3 space-y-2">
          <button
            type="button"
            onClick={() => {
              setNotice(null);
              setMode(primary.mode);
            }}
            disabled={primary.disabled}
            aria-haspopup="dialog"
            className="w-full h-11 rounded-full bg-terracotta text-bone text-sm font-medium inline-flex items-center justify-center hover:brightness-95 disabled:opacity-50"
          >
            {primary.label}
          </button>
          {info.open && !customer && info.canSend && <p className="text-[11px] text-op-muted">{t("needsCustomer")}</p>}
        </div>
      )}

      {info.unavailable === "online_payments_unavailable" && (
        <p className="mt-2 text-[11px] text-op-muted">
          {t("unavailableOnline")}{" "}
          <Link href="/operator/settings/pagos" className="underline hover:text-op-text">
            {t("goToPayments")}
          </Link>
        </p>
      )}

      {showSecondary && (
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <button type="button" onClick={copy} disabled={busy !== null} className="mp-btn mp-btn--secondary mp-btn--sm">
            {busy === "copy" ? t("working") : t("copyLink")}
          </button>
          <button type="button" onClick={whatsapp} disabled={busy !== null} className="mp-btn mp-btn--secondary mp-btn--sm">
            {busy === "whatsapp" ? t("working") : t("whatsapp")}
          </button>
        </div>
      )}
      {info.open && info.canSend && (
        <button
          type="button"
          onClick={() => {
            setNotice(null);
            setMode("link");
          }}
          className="mt-2 w-full text-center text-[11px] text-op-muted underline hover:text-op-text"
        >
          {t("linkOnlyButton")}
        </button>
      )}

      {receivable && !settled && receivable.outstandingCents > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <button type="button" onClick={() => setPayOpen(true)} className="underline hover:text-op-text">
            {t("registerPayment")}
          </button>
          <Link href={`/operator/reportes/cartera/cliente/${encodeURIComponent(receivable.billingCustomerId)}`} className="underline hover:text-op-text">
            {t("viewInCartera")}
          </Link>
        </div>
      )}
      {receivable && settled && (
        <div className="mt-2 text-xs">
          <Link href={`/operator/reportes/cartera/cliente/${encodeURIComponent(receivable.billingCustomerId)}`} className="underline hover:text-op-text">
            {t("viewInCartera")}
          </Link>
        </div>
      )}

      {link && (link.state === "open" || link.state === "expired") && variant === "panel" && (
        <p className="mt-2 text-[11px] text-op-muted break-all font-mono">{link.url}</p>
      )}

      {notice && (
        <p role="status" className={"mt-2 text-xs " + (notice.ok ? "text-[#1E5339]" : "text-danger")}>
          {notice.text}
        </p>
      )}

      {mode && (
        <ManualInvoiceSendDialog
          info={info}
          mode={mode}
          customerName={customer}
          suggestedEmails={suggested}
          onClose={() => setMode(null)}
          onDone={(result) => {
            if (result.issued && afterIssue === "open-order") {
              // La cuenta ya no está en Mesas: su ficha muestra cómo quedó.
              router.push(`/operator/orders/${encodeURIComponent(info.orderId)}?enviada=1`);
              return;
            }
            router.refresh();
          }}
        />
      )}

      {payOpen && receivable && (
        <CreditPaymentSheet
          customer={{
            id: receivable.billingCustomerId,
            customerName: receivable.customerName ?? customer ?? "",
            debtCents: receivable.outstandingCents,
          }}
          currency={info.currency}
          creditChargeId={receivable.chargeId}
          onClose={() => setPayOpen(false)}
          onSaved={() => {
            setPayOpen(false);
            setNotice({ ok: true, text: t("paymentRegistered") });
            router.refresh();
          }}
        />
      )}
    </section>
  );
}

/**
 * La hoja del envío: a quiénes (hasta 5 correos) y qué pasa al confirmar.
 *   · issue  — emite la factura, la manda con el link y saca la cuenta de Mesas.
 *   · link   — sólo el link (la cuenta sigue abierta en Mesas).
 *   · resend — la factura ya emitida, con su link (renovado si venció).
 */
export function ManualInvoiceSendDialog({
  info,
  mode,
  customerName,
  suggestedEmails,
  onClose,
  onDone,
}: {
  info: ManualInvoiceSendInfo;
  mode: Mode;
  customerName: string | null;
  suggestedEmails: string[];
  onClose: () => void;
  onDone: (result: { issued: boolean }) => void;
}) {
  const { t, locale, list, errorText } = useSendText();
  const id = useId();
  const money = (cents: number) => formatMoney(cents, { currency: info.currency, locale, fractionDigits: "auto" });
  const [emails, setEmails] = useState<string[]>(suggestedEmails.length > 0 ? suggestedEmails.slice(0, MAX_RECIPIENTS) : [""]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ text: string; ok: boolean; issued: boolean; url: string } | null>(null);

  const clean = emails.map((e) => e.trim()).filter(Boolean);
  const valid = clean.every((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  // Emitir exige al menos un correo: es "emitir Y enviar". El link solo
  // también se puede generar sin correo (copiar / WhatsApp), pero acá es
  // la hoja del envío por correo.
  const canSubmit = !busy && clean.length > 0 && valid;

  const title = mode === "issue" ? (info.invoiceNumber ? t("sendIssuedButton") : t("dialogTitleIssue")) : mode === "resend" ? t("dialogTitleResend") : t("dialogTitleLink");
  const summary =
    mode === "issue"
      ? t("dialogIssueSummary", { amount: money(info.outstandingCents), customer: customerName ?? "" })
      : mode === "resend"
        ? t("dialogResendSummary", { amount: money(info.outstandingCents) })
        : t("dialogLinkSummary", { amount: money(info.outstandingCents) });

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const { ok, data } = await callPayLink(info.orderId, { emails: clean, ...(mode === "issue" ? { issue: true } : {}) });
      if (!ok) {
        setError(errorText(data.error));
        return;
      }
      const sent = data.sentTo?.filter((e) => clean.includes(e)) ?? [];
      const failed = data.failed ?? [];
      const text = data.issued
        ? data.emailFailed
          ? t("doneIssuedNoEmail")
          : t("doneIssued", { emails: list(sent.length > 0 ? sent : clean) })
        : t("doneSent", { emails: list(sent.length > 0 ? sent : clean) });
      setDone({
        text: failed.length > 0 && !data.emailFailed ? `${text} ${t("donePartial", { emails: list(failed) })}` : text,
        ok: !data.emailFailed && failed.length === 0,
        issued: !!data.issued,
        url: data.url ?? "",
      });
      // Emitida: la cuenta se va de Mesas. Se avisa ya para que la ficha
      // de la orden cargue con el estado nuevo.
      if (data.issued) onDone({ issued: true });
    } catch {
      setError(t("errGeneric"));
    } finally {
      setBusy(false);
    }
  }

  function close() {
    if (busy) return;
    if (done && !done.issued) onDone({ issued: false });
    onClose();
  }

  return (
    <AppDialog label={title} onClose={close} dismissOnBackdrop={false} placement="center" className="rounded-2xl">
      <div className="p-5 space-y-4 w-full max-w-md">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="font-display text-xl">{title}</h2>
            <p className="text-xs text-op-muted mt-1">{summary}</p>
          </div>
          <button type="button" onClick={close} disabled={busy} className="text-op-muted text-sm shrink-0" aria-label={t("close")}>
            {"✕"}
          </button>
        </div>

        {done ? (
          <div className="space-y-3">
            <p role="status" className={"text-sm " + (done.ok ? "text-[#1E5339]" : "text-danger")}>
              {done.text}
            </p>
            {done.url && <p className="text-[11px] text-op-muted break-all font-mono">{done.url}</p>}
            <button type="button" onClick={close} className="mp-btn mp-btn--primary mp-btn--block">
              {t("close")}
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <fieldset disabled={busy} className="space-y-2">
              <legend className="block text-xs font-medium text-op-text mb-1">{t("recipientsLabel")}</legend>
              {emails.map((value, index) => (
                <div key={index} className="flex items-center gap-2">
                  <input
                    id={`${id}-email-${index}`}
                    type="email"
                    value={value}
                    onChange={(e) => setEmails((prev) => prev.map((v, i) => (i === index ? e.target.value : v)))}
                    placeholder={t("recipientPlaceholder")}
                    aria-label={t("recipientAria", { n: index + 1 })}
                    maxLength={160}
                    autoComplete="email"
                    className="h-10 min-w-0 flex-1 rounded-xl border border-op-border bg-op-bg px-3 text-sm text-op-text placeholder:text-op-muted focus:border-op-text/30 focus:outline-none"
                  />
                  {emails.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setEmails((prev) => prev.filter((_, i) => i !== index))}
                      className="h-10 w-10 shrink-0 rounded-full border border-op-border text-op-muted hover:text-op-text"
                      aria-label={t("removeRecipient")}
                    >
                      {"✕"}
                    </button>
                  )}
                </div>
              ))}
              {emails.length < MAX_RECIPIENTS && (
                <button
                  type="button"
                  onClick={() => setEmails((prev) => [...prev, ""])}
                  className="text-xs text-op-text underline"
                >
                  {t("addRecipient")}
                </button>
              )}
              <p className="text-[11px] text-op-muted">{t("recipientsHint", { max: MAX_RECIPIENTS })}</p>
            </fieldset>
            {error && (
              <p role="alert" className="text-xs text-danger">
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={!canSubmit}
              className="w-full h-11 rounded-full bg-terracotta text-bone text-sm font-medium inline-flex items-center justify-center hover:brightness-95 disabled:opacity-50"
            >
              {busy ? (mode === "issue" ? t("issuing") : t("sending")) : mode === "issue" ? t("submitIssue") : t("submitSend")}
            </button>
          </form>
        )}
      </div>
    </AppDialog>
  );
}

/**
 * Botón compacto para la fila de Órdenes: la factura manual abierta
 * ("Enviar factura") o emitida por cobrar ("Reenviar"). Abre la misma hoja.
 */
export function ManualInvoiceSendButton({ info }: { info: ManualInvoiceSendInfo }) {
  const { t } = useSendText();
  const router = useRouter();
  const [mode, setMode] = useState<Mode | null>(null);
  const settled = info.link?.state === "paid" || info.link?.state === "cancelled";
  const action: { mode: Mode; label: string } | null =
    !info.canSend || settled
      ? null
      : info.open
        ? info.customerName
          ? { mode: "issue", label: info.invoiceNumber ? t("sendIssuedButton") : t("rowIssue") }
          : { mode: "link", label: t("rowLink") }
        : info.receivable
          ? { mode: "resend", label: t("rowResend") }
          : null;
  if (!action) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setMode(action.mode)}
        className="relative z-10 inline-flex h-8 items-center rounded-full border border-terracotta/40 px-3 text-xs font-medium text-terracotta hover:bg-terracotta/10"
      >
        {action.label}
      </button>
      {mode && (
        <ManualInvoiceSendDialog
          info={info}
          mode={mode}
          customerName={info.customerName}
          suggestedEmails={info.suggestedEmails}
          onClose={() => setMode(null)}
          onDone={() => router.refresh()}
        />
      )}
    </>
  );
}
