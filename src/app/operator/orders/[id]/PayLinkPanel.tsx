"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { AppDialog } from "@/components/ui/AppDialog";
import { formatDate, formatMoney } from "@/lib/format";
import type { Locale } from "@/i18n/config";

/**
 * "Enviar link de pago" de una FACTURA MANUAL (ficha de la orden).
 *
 * Sólo se monta cuando el server ya decidió que aplica (mesa `manual`,
 * cuenta abierta con saldo, Kushki activo) o cuando la cuenta ya tiene un
 * link y sólo hay que mostrar su estado. Abre una hoja con: el correo del
 * cliente (prellenado con el de la factura pedida, si lo hay), **Enviar por
 * correo**, **Copiar link** y **Compartir por WhatsApp**. Las tres acciones
 * pasan por la misma API (`POST …/pay-link`), que crea o renueva el link y
 * —con correo— lo manda; así el link que se copia es el mismo que llega
 * por correo.
 *
 * Los errores llegan como CÓDIGO y se traducen acá.
 */
export type PayLinkView = {
  url: string;
  expiresAt: string;
  sentTo: string | null;
  sentAt: string | null;
  state: "open" | "paid" | "cancelled" | "expired";
};

export function PayLinkPanel({
  orderId,
  initial,
  canSend,
  suggestedEmail,
  outstandingCents,
  currency,
  tenantName,
  orderCode,
}: {
  orderId: string;
  /** Link existente (si lo hay), con su estado derivado de la orden. */
  initial: PayLinkView | null;
  /** El gate del server: se puede crear/enviar (cuenta abierta con saldo y Kushki activo). */
  canSend: boolean;
  /** Correo del cliente identificado en la cuenta, para prellenar. */
  suggestedEmail: string | null;
  outstandingCents: number;
  currency: string;
  tenantName: string;
  orderCode: string;
}) {
  const t = useTranslations("opOrders");
  const locale = useLocale() as Locale;
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [link, setLink] = useState<PayLinkView | null>(initial);
  const [email, setEmail] = useState(suggestedEmail ?? "");
  const [busy, setBusy] = useState<"email" | "copy" | "whatsapp" | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const money = (cents: number) => formatMoney(cents, { currency, locale });
  const when = (iso: string) => formatDate(iso, { locale });

  function errorText(code: string | undefined): string {
    switch (code) {
      case "not_manual_invoice":
      case "order_closed":
        return t("payLinkErrClosed");
      case "nothing_to_pay":
        return t("payLinkErrNothingToPay");
      case "online_payments_unavailable":
        return t("payLinkErrOnlineUnavailable");
      case "email_failed":
        return t("payLinkErrEmail");
      case "invalid":
        return t("payLinkErrInvalidEmail");
      default:
        return t("payLinkErrGeneric");
    }
  }

  /** Crea o renueva el link (y, con `sendTo`, lo manda por correo). */
  async function ensureLink(sendTo?: string): Promise<PayLinkView | null> {
    const res = await fetch(`/api/operator/orders/${encodeURIComponent(orderId)}/pay-link`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sendTo ? { email: sendTo } : {}),
    });
    const j = (await res.json().catch(() => ({}))) as Partial<PayLinkView> & { error?: string };
    if (!res.ok || !j.url || !j.expiresAt) {
      setNotice({ ok: false, text: errorText(j.error) });
      return null;
    }
    const next: PayLinkView = {
      url: j.url,
      expiresAt: j.expiresAt,
      sentTo: j.sentTo ?? null,
      sentAt: j.sentAt ?? null,
      state: "open",
    };
    setLink(next);
    return next;
  }

  async function sendByEmail() {
    const to = email.trim();
    if (!to || busy) return;
    setBusy("email");
    setNotice(null);
    try {
      const next = await ensureLink(to);
      if (next) {
        setNotice({ ok: true, text: t("payLinkSentTo", { email: to }) });
        router.refresh();
      }
    } catch {
      setNotice({ ok: false, text: t("payLinkErrGeneric") });
    } finally {
      setBusy(null);
    }
  }

  async function copyLink() {
    if (busy) return;
    setBusy("copy");
    setNotice(null);
    try {
      const next = link?.state === "open" ? link : await ensureLink();
      if (!next) return;
      try {
        await navigator.clipboard.writeText(next.url);
        setNotice({ ok: true, text: t("payLinkCopied") });
      } catch {
        // Sin portapapeles (http, permisos): el link queda a la vista para
        // copiarlo a mano.
        setNotice({ ok: false, text: t("payLinkCopyFailed") });
      }
    } finally {
      setBusy(null);
    }
  }

  async function shareWhatsApp() {
    if (busy) return;
    setBusy("whatsapp");
    setNotice(null);
    try {
      const next = link?.state === "open" ? link : await ensureLink();
      if (!next) return;
      const text = t("payLinkWhatsAppText", {
        restaurant: tenantName,
        code: orderCode,
        amount: money(outstandingCents),
        url: next.url,
      });
      // Sin número: WhatsApp abre el selector de chat con el mensaje listo.
      window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank", "noopener,noreferrer");
    } finally {
      setBusy(null);
    }
  }

  const stateLine = link
    ? link.state === "paid"
      ? t("payLinkStatePaid")
      : link.state === "cancelled"
        ? t("payLinkStateCancelled")
        : link.state === "expired"
          ? t("payLinkStateExpired", { date: when(link.expiresAt) })
          : link.sentTo && link.sentAt
            ? t("payLinkStateSent", { email: link.sentTo, date: when(link.sentAt) })
            : t("payLinkStateOpen", { date: when(link.expiresAt) })
    : null;

  return (
    <div className="mt-4 bg-op-surface border border-op-border rounded-2xl p-4">
      <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
        {t("payLinkSection")}
      </div>
      <p className="text-sm text-op-muted">{t("payLinkIntro")}</p>
      {stateLine && (
        <p
          className={
            "mt-2 text-xs " + (link?.state === "paid" ? "text-[#1E5339]" : link?.state === "open" ? "text-op-text" : "text-op-muted")
          }
        >
          {stateLine}
        </p>
      )}
      {canSend && (
        <div className="mt-3">
          <button type="button" onClick={() => setOpen(true)} className="mp-btn mp-btn--primary mp-btn--sm" aria-haspopup="dialog">
            {t("payLinkButton")}
          </button>
        </div>
      )}

      {open && (
        <AppDialog label={t("payLinkButton")} onClose={() => setOpen(false)} dismissOnBackdrop={false} placement="center" className="rounded-2xl">
          <div className="p-5 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-display text-xl">{t("payLinkTitle")}</h2>
                <p className="text-xs text-op-muted mt-1">
                  {t("payLinkDialogIntro", { amount: money(outstandingCents) })}
                </p>
              </div>
              <button type="button" onClick={() => setOpen(false)} className="text-op-muted text-sm shrink-0" aria-label={t("payLinkClose")}>
                {"✕"}
              </button>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                void sendByEmail();
              }}
              className="space-y-2"
            >
              <label htmlFor="pay-link-email" className="block text-xs font-medium text-op-text">
                {t("payLinkEmailLabel")}
              </label>
              <input
                id="pay-link-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t("payLinkEmailPlaceholder")}
                maxLength={160}
                className="h-10 w-full rounded-xl border border-op-border bg-op-bg px-3 text-sm text-op-text placeholder:text-op-muted focus:border-op-text/30 focus:outline-none"
              />
              <button type="submit" disabled={busy !== null || !email.trim()} className="mp-btn mp-btn--primary mp-btn--block">
                {busy === "email" ? t("payLinkSending") : t("payLinkSendEmail")}
              </button>
            </form>

            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={copyLink} disabled={busy !== null} className="mp-btn mp-btn--secondary">
                {busy === "copy" ? t("payLinkWorking") : t("payLinkCopy")}
              </button>
              <button type="button" onClick={shareWhatsApp} disabled={busy !== null} className="mp-btn mp-btn--secondary">
                {busy === "whatsapp" ? t("payLinkWorking") : t("payLinkWhatsApp")}
              </button>
            </div>

            {link?.state === "open" && (
              <p className="text-[11px] text-op-muted break-all">
                <span className="font-mono">{link.url}</span>
                <br />
                {t("payLinkExpires", { date: when(link.expiresAt) })}
              </p>
            )}
            {notice && (
              <p role="status" className={"text-xs " + (notice.ok ? "text-[#1E5339]" : "text-danger")}>
                {notice.text}
              </p>
            )}
          </div>
        </AppDialog>
      )}
    </div>
  );
}
