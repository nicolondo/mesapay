"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

/**
 * "Factura genérica" (tirilla a consumidor final): sólo correo, sin datos del
 * comensal. Flujo independiente del formal (`InvoiceFormSheet`).
 *
 * Dos momentos, un mismo sheet:
 *  - `beforePayment` (checkout): la orden todavía no está paga. No hay nada
 *    que imprimir, así que el correo es OBLIGATORIO — es lo único que
 *    permite mandarla cuando el cobro se confirme. El backend guarda la
 *    intención y responde `deferred: true`.
 *  - después de pagar (/done): como siempre, el correo es opcional y la
 *    factura se emite en el momento para imprimir o descargar.
 *
 * Las claves i18n viven en el namespace `done` — nació ahí y renombrarlas
 * costaría tocar los tres catálogos sin ganar nada.
 */
export function SimpleInvoiceSheet({
  tenantSlug,
  orderId,
  prefillEmail = null,
  beforePayment = false,
  operatorMode = false,
  onClose,
  onSaved,
}: {
  tenantSlug: string;
  orderId: string;
  /** Correo que el comensal ya tipeó al pagar con tarjeta, si lo tenemos. */
  prefillEmail?: string | null;
  /** La orden todavía no está paga (se está pidiendo desde el checkout). */
  beforePayment?: boolean;
  /** El mesero cobra por el cliente: la copia va en tercera persona. */
  operatorMode?: boolean;
  onClose: () => void;
  /** Se dispara con el correo guardado, para que el caller pinte el resumen. */
  onSaved?: (email: string) => void;
}) {
  const t = useTranslations("done");
  // Prellenado con el correo que el diner tipeó al pagar con tarjeta: así no
  // vuelve a escribirlo, sólo confirma y genera.
  const [email, setEmail] = useState(prefillEmail ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<
    | { deferred: true; email: string }
    | { deferred: false; invoiceUrl: string; email: string }
    | null
  >(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const mail = email.trim();
    if (beforePayment && mail === "") {
      setErr(t("invErrEmailRequired"));
      return;
    }
    // Después del pago el correo es OPCIONAL: sin él la factura igual se
    // genera para imprimir/descargar. Sólo se valida si escribió algo.
    if (mail !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
      setErr(t("invErrEmail"));
      return;
    }
    setBusy(true);
    setErr(null);
    const r = await fetch(
      `/api/tenant/${tenantSlug}/orders/${orderId}/simple-invoice`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: mail }),
      },
    );
    setBusy(false);
    if (!r.ok) {
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      setErr(simpleInvoiceError(j.error, t));
      return;
    }
    const j = (await r.json()) as { invoiceUrl?: string; deferred?: boolean };
    if (j.deferred) {
      setDone({ deferred: true, email: mail });
    } else {
      setDone({ deferred: false, invoiceUrl: j.invoiceUrl ?? "", email: mail });
    }
    onSaved?.(mail);
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
      onClick={onClose}
    >
      <div
        className="w-full md:max-w-md bg-paper rounded-t-3xl md:rounded-3xl border border-hairline p-5 space-y-4 max-h-[90dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-muted">
              {t("invSimpleLabel")}
            </div>
            <h2 className="font-display text-2xl mt-1">
              {!done
                ? t("invYourReceipt")
                : done.deferred
                  ? t("invDeferredTitle")
                  : done.email
                    ? t("invSentTitle")
                    : t("invGeneratedReady")}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted text-sm shrink-0"
            aria-label={t("close")}
          >
            {"✕"}
          </button>
        </div>

        {done ? (
          <>
            <p className="text-sm text-ink/80">
              {done.deferred ? (
                t.rich(operatorMode ? "invDeferredBodyOp" : "invDeferredBody", {
                  email: done.email,
                  b: (chunks) => <strong>{chunks}</strong>,
                })
              ) : done.email ? (
                t.rich("invSentBody", {
                  email: done.email,
                  b: (chunks) => <strong>{chunks}</strong>,
                })
              ) : (
                <span>{t("invGeneratedReadyBody")}</span>
              )}
            </p>
            {!done.deferred && (
              <a
                href={`${done.invoiceUrl}?print=1`}
                target="_blank"
                rel="noreferrer"
                className="block text-center w-full h-12 leading-[3rem] rounded-2xl bg-ink text-bone text-sm font-medium"
              >
                {t("invPrintInvoice")}
              </a>
            )}
            <button
              type="button"
              onClick={onClose}
              className="w-full h-10 rounded-2xl border border-hairline text-sm"
            >
              {t("close")}
            </button>
          </>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <p className="text-sm text-muted">
              {beforePayment
                ? t(
                    operatorMode
                      ? "invSimpleIntroBeforeOp"
                      : "invSimpleIntroBefore",
                  )
                : t("invSimpleIntro")}
            </p>
            <label className="block">
              <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-1">
                {beforePayment ? t("invEmailField") : t("invEmailFieldOptional")}
              </div>
              <input
                type="email"
                inputMode="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t("invEmailPlaceholder")}
                className="w-full h-11 px-3 rounded-lg border border-hairline bg-paper text-sm"
              />
            </label>
            {err && <div className="text-xs text-danger">{err}</div>}
            <button
              type="submit"
              disabled={busy}
              className="w-full h-12 rounded-2xl bg-ink text-bone text-base font-medium disabled:opacity-50"
            >
              {busy
                ? beforePayment
                  ? t("invSaving")
                  : t("invGenerating")
                : beforePayment
                  ? t("invRequestInvoice")
                  : t("invGenerateInvoice")}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

function simpleInvoiceError(
  code: string | undefined,
  t: ReturnType<typeof useTranslations>,
): string {
  switch (code) {
    case "invalid_email":
      return t("invErrEmail");
    case "email_required":
      return t("invErrEmailRequired");
    case "not_found":
      return t("invErrNotFound");
    default:
      return t("invErrGenerate");
  }
}
