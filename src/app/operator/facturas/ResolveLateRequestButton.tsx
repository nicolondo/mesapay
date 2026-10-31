"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

/**
 * "Marcar como resuelta" de una solicitud que llegó cuando la factura ya
 * había salido a consumidor final. Usa la ruta de siempre de las
 * solicitudes (`PATCH /api/operator/invoice-requests/[id]`) con `rejected`:
 * la factura NO salió con esos datos, y los reportes (impuestos, exógena)
 * toman como adquiriente cualquier solicitud que no esté rechazada — dejarla
 * `generated` atribuiría la venta a alguien que no figura en la factura.
 */
export function ResolveLateRequestButton({ requestId }: { requestId: string }) {
  const t = useTranslations("opEInvoices");
  const router = useRouter();
  const [, startTx] = useTransition();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function resolve() {
    if (busy || !window.confirm(t("lateResolveConfirm"))) return;
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch(`/api/operator/invoice-requests/${requestId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "rejected" }),
      });
      if (res.ok) startTx(() => router.refresh());
      else setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={resolve}
        disabled={busy}
        className="mp-btn mp-btn--ghost mp-btn--sm"
      >
        {busy ? t("lateResolving") : t("lateResolve")}
      </button>
      {failed && (
        <span role="status" className="basis-full text-[11px] text-danger">
          {t("lateResolveError")}
        </span>
      )}
    </>
  );
}
