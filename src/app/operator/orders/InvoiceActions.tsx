"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { ReprintInvoiceButton } from "./ReprintInvoiceButton";

/**
 * Acciones sobre la factura de una cuenta ya cobrada, en la lista y en el
 * detalle de pedidos: ver la tirilla, reimprimirla y —con facturación
 * electrónica y la factura ACEPTADA por la DIAN— reenviarla por correo.
 *
 * `dianDocumentId` llega ya filtrado por el server (módulo `einvoicing`
 * activo + estado `accepted`): acá no se decide nada, sólo se muestra.
 */
export function InvoiceActions({
  orderId,
  invoiceId,
  dianDocumentId,
}: {
  orderId: string;
  invoiceId: string;
  dianDocumentId: string | null;
}) {
  const t = useTranslations("opOrders");
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <a
        href={`/factura/${invoiceId}`}
        target="_blank"
        rel="noreferrer"
        className="mp-btn mp-btn--ghost mp-btn--sm"
      >
        {t("viewInvoice")}
      </a>
      <ReprintInvoiceButton orderId={orderId} invoiceId={invoiceId} />
      {dianDocumentId && <ResendInvoiceEmailButton documentId={dianDocumentId} />}
    </div>
  );
}

/**
 * Reenvío de la factura electrónica al adquiriente. Usa la ruta que ya
 * existe para Facturas (`dian/documents/[id]/resend-email`, con `force`):
 * misma puerta, mismo correo, mismos motivos de fallo.
 */
function ResendInvoiceEmailButton({ documentId }: { documentId: string }) {
  const t = useTranslations("opOrders");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function resend() {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(
        `/api/operator/dian/documents/${documentId}/resend-email`,
        { method: "POST" },
      );
      const j = (await res.json().catch(() => ({}))) as {
        sentTo?: string;
        attachment?: boolean;
        error?: string;
      };
      if (res.ok && j.sentTo) {
        setMsg({
          ok: true,
          text:
            j.attachment === false
              ? t("resendSentNoAttachment", { email: j.sentTo })
              : t("resendSent", { email: j.sentTo }),
        });
      } else {
        setMsg({
          ok: false,
          text:
            j.error === "no_recipient"
              ? t("resendNoRecipient")
              : t("resendError"),
        });
      }
    } catch {
      setMsg({ ok: false, text: t("resendError") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={resend}
        disabled={busy}
        className="mp-btn mp-btn--ghost mp-btn--sm"
      >
        {busy ? t("resending") : t("resendEmail")}
      </button>
      {msg && (
        <span
          role="status"
          className={
            "basis-full text-[11px] " +
            (msg.ok ? "text-[#1E5339]" : "text-danger")
          }
        >
          {msg.text}
        </span>
      )}
    </>
  );
}
