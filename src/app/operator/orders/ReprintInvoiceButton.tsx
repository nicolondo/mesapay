"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

type Notice =
  | { tone: "ok"; text: string }
  | { tone: "warn"; text: string; href: string | null }
  | { tone: "error"; text: string };

/**
 * "Reimprimir factura": vuelve a mandar la tirilla a las impresoras de
 * factura del comercio (POST /api/operator/orders/[id]/reprint-invoice).
 * Si el local no tiene impresora de facturas, abre la versión imprimible
 * del navegador (/factura/[id]?print=1) en una pestaña nueva y lo dice:
 * el papel sale igual, por otro camino.
 *
 * El aviso de éxito se va solo (como el de "Enviada al datáfono" en
 * Facturas); el de "sin impresora" y el de error se quedan, porque le
 * piden algo al que mira (ir a la pestaña nueva, reintentar).
 *
 * Va pensado para vivir dentro de un contenedor `flex flex-wrap`: el
 * aviso ocupa la fila entera (`basis-full`) debajo de los botones.
 */
export function ReprintInvoiceButton({
  orderId,
  invoiceId,
}: {
  orderId: string;
  invoiceId: string;
}) {
  const t = useTranslations("opOrders");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  async function reprint() {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(
        `/api/operator/orders/${orderId}/reprint-invoice`,
        { method: "POST" },
      );
      const j = (await res.json().catch(() => ({}))) as {
        queued?: boolean;
        reason?: string;
        error?: string;
      };
      if (res.ok && j.queued) {
        setNotice({ tone: "ok", text: t("reprintSent") });
        timer.current = setTimeout(() => setNotice(null), 3000);
      } else if (res.ok && j.reason === "no_printer") {
        const href = `/factura/${invoiceId}?print=1`;
        // Sin `noopener` a propósito: con esa opción `window.open` devuelve
        // null aunque abra, y acá el null es la señal de que el navegador
        // bloqueó la pestaña (Safari es estricto después de un await). La
        // página es nuestra, así que no hay opener ajeno que cuidar.
        const opened = window.open(href, "_blank");
        setNotice({
          tone: "warn",
          text: t("reprintNoPrinter"),
          href: opened ? null : href,
        });
      } else {
        setNotice({ tone: "error", text: t("reprintError") });
      }
    } catch {
      setNotice({ tone: "error", text: t("reprintError") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={reprint}
        disabled={busy}
        className="mp-btn mp-btn--secondary mp-btn--sm"
      >
        {busy ? t("reprinting") : t("reprintInvoice")}
      </button>
      {notice && (
        <span
          role="status"
          className={
            "basis-full text-[11px] " +
            (notice.tone === "error"
              ? "text-danger"
              : notice.tone === "warn"
                ? "text-[#8F6828]"
                : "text-[#1E5339]")
          }
        >
          {notice.text}
          {notice.tone === "warn" && notice.href && (
            <>
              {" "}
              <a
                href={notice.href}
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                {t("reprintOpenBrowser")}
              </a>
            </>
          )}
        </span>
      )}
    </>
  );
}
