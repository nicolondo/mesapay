"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  BrowserPrintStatus,
  browserPrintStateFrom,
  type BrowserPrintState,
} from "@/components/BrowserPrintStatus";
import {
  agentMessage,
  printAsStaff,
  type StaffPrintDoc,
  type StaffPrintFallbackReason,
} from "@/lib/print/staffPrint";

type Tone = "ok" | "warn" | "error";

type Notice = {
  tone: Tone;
  text: string;
  /** Por qué se cayó al navegador (para el aviso de configurar). */
  fallback?: StaffPrintFallbackReason;
};

/**
 * Botón "Imprimir factura" (o precuenta) del STAFF: por el AGENTE, como las
 * comandas, y el navegador sólo como respaldo (ver `staffPrint.ts`).
 *
 * Debajo, en una línea, lo que pasó: "Enviada a Caja ✓" (se va sola), que
 * salió el comprobante porque la DIAN todavía no aceptó la electrónica, o
 * que no hay impresora de facturas y se imprime desde el navegador — con
 * el estado de esa impresión y, para quien puede, el link a elegir una
 * impresora del agente (`canConfigurePrinters`; el mesero ve a quién
 * pedírselo).
 *
 * NO es para el comensal: su pantalla abre la vista de la factura como
 * siempre. La ruta de todos modos exige sesión de staff.
 */
export function StaffPrintButton({
  doc,
  label,
  className,
  statusClassName = "block text-[11px]",
  sameTab = false,
  canConfigurePrinters = false,
  openTab,
}: {
  doc: StaffPrintDoc;
  /** El texto del botón, ya traducido ("Imprimir factura"). */
  label: string;
  className?: string;
  statusClassName?: string;
  /** PWA del mesero: los links del respaldo navegan in-app. */
  sameTab?: boolean;
  /** Puede entrar a Configuración → Impresoras de red. */
  canConfigurePrinters?: boolean;
  /** Cómo abrir la pestaña de respaldo (en la PWA, navegación in-app). */
  openTab?: (url: string) => boolean;
}) {
  const t = useTranslations("staffPrint");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [browser, setBrowser] = useState<BrowserPrintState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  async function run() {
    if (busy) return;
    if (timer.current) clearTimeout(timer.current);
    setBusy(true);
    setNotice(null);
    setBrowser(null);
    try {
      const result = await printAsStaff(doc, {
        openTab,
        onBrowserFallback: (reason) => {
          setNotice({
            tone: "warn",
            text: t(reason === "agent_offline" ? "agentOffline" : "noPrinter"),
            fallback: reason,
          });
          setBrowser({ step: "preparing" });
        },
      });
      if (result.via === "agent") {
        const m = agentMessage(result);
        setNotice({ tone: m.tone, text: t(m.key, m.values) });
        // El éxito se va solo; el aviso de la DIAN se queda (pide algo).
        if (m.tone === "ok") timer.current = setTimeout(() => setNotice(null), 4000);
      } else if (result.via === "browser") {
        setBrowser(browserPrintStateFrom(result.outcome, result.tabUrl));
      } else {
        setBrowser(null);
        setNotice({ tone: "error", text: t("failed") });
      }
    } catch {
      setBrowser(null);
      setNotice({ tone: "error", text: t("failed") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" onClick={run} disabled={busy} className={className}>
        {busy ? t("sending") : label}
      </button>
      {notice && (
        <span
          role="status"
          className={
            statusClassName +
            " " +
            (notice.tone === "error"
              ? "text-danger"
              : notice.tone === "warn"
                ? "text-[#8F6828]"
                : "text-[#1E5339]")
          }
        >
          {notice.text}
          {browser && (
            <>
              {" "}
              <BrowserPrintStatus
                state={browser}
                sameTab={sameTab}
                setup={
                  notice.fallback === "no_printer"
                    ? canConfigurePrinters
                      ? "link"
                      : "ask"
                    : null
                }
              />
            </>
          )}
        </span>
      )}
    </>
  );
}
