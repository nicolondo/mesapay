"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { InvoiceDianStatus } from "@/lib/dian/invoiceList";
import { blockReasonText } from "./EmissionBanner";

/**
 * "Reintentar emisión" de una factura que no salió: rechazada por la DIAN,
 * con error de envío o frenada por configuración. Es el mismo reintento de
 * siempre (`POST /api/operator/dian/emit/[simpleInvoiceId]`, que reclama el
 * documento y no re-emite lo aceptado ni lo que está en vuelo); acá sólo se
 * muestra con su advertencia, porque cada caso pide algo distinto antes de
 * apretar.
 */
export function RetryEmissionButton({
  simpleInvoiceId,
  status,
}: {
  simpleInvoiceId: string;
  status: InvoiceDianStatus;
}) {
  const t = useTranslations("opEInvoices");
  const tf = useTranslations("opFacturas");
  const router = useRouter();
  const [, startTx] = useTransition();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const warning =
    status === "rejected"
      ? t("retryWarnRejected")
      : status === "not_sent"
        ? t("retryWarnBlocked")
        : t("retryWarnError");

  async function retry() {
    if (busy || !window.confirm(warning)) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/operator/dian/emit/${simpleInvoiceId}`, {
        method: "POST",
      });
      const data = (await res.json().catch(() => null)) as {
        document?: { state: string };
        error?: string;
      } | null;
      if (res.ok && data?.document) {
        const state = data.document.state;
        setMsg({
          ok: state === "accepted" || state === "pending",
          text:
            state === "accepted"
              ? t("retryAccepted")
              : state === "pending"
                ? t("retryPending")
                : state === "rejected"
                  ? t("retryRejected")
                  : t("retryChannelError"),
        });
      } else if (res.status === 409) {
        setMsg({ ok: false, text: t("retryAlready") });
      } else if (res.status === 400 && data?.error) {
        setMsg({ ok: false, text: t("retryBlocked", { reason: blockReasonText(data.error, tf) }) });
      } else {
        setMsg({ ok: false, text: t("retryFailed") });
      }
      startTx(() => router.refresh());
    } catch {
      setMsg({ ok: false, text: t("retryFailed") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={retry}
        disabled={busy}
        className="mp-btn mp-btn--secondary mp-btn--sm"
      >
        {busy ? t("retrying") : t("retry")}
      </button>
      <span className="basis-full text-[11px] text-op-muted">{warning}</span>
      {msg && (
        <span
          role="status"
          className={"basis-full text-[11px] " + (msg.ok ? "text-[#1E5339]" : "text-danger")}
        >
          {msg.text}
        </span>
      )}
    </>
  );
}
