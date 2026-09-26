"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { isEmbeddedFrame } from "@/lib/printInBrowser";
import { fitPageToContent } from "@/lib/print/fitPageToContent";
import {
  agentMessage,
  printAsStaff,
  type StaffPrintDoc,
} from "@/lib/print/staffPrint";

/**
 * Botón "Imprimir" de las vistas imprimibles (la factura `/factura/[id]` y
 * la precuenta). Anteriormente usábamos un form con
 * `action="javascript:window.print()"` pero React/los navegadores
 * modernos lo bloquean por XSS — el onClick directo es la forma
 * idiomática.
 *
 * Al imprimir desde ESTA página, primero `fitPageToContent`: una sola
 * página del alto del documento, para que el driver de la térmica no la
 * corte en dos tiras. También con Ctrl+P (`beforeprint`).
 *
 * `agent` (sólo cuando mira el STAFF del comercio, lo decide el server):
 * el botón manda el documento al AGENTE, como las comandas, y dice por
 * cuál impresora salió; si el local no tiene impresora de facturas (o su
 * agente no responde), imprime esta misma página como siempre. Sin
 * `agent` (el comensal) imprime esta página y nada más.
 *
 * `autoPrint` (llegado como ?print=1): abre el diálogo de impresión solo
 * al cargar — es la pestaña de respaldo de los botones del staff, así que
 * NO vuelve a intentar el agente. Sólo en pestaña propia: cuando la
 * tirilla viene embebida en el iframe oculto de `printUrlInHiddenFrame`
 * es ese helper el que imprime, y si la página también lo hiciera saldrían
 * dos diálogos.
 */
export function PrintButton({
  autoPrint = false,
  agent = null,
}: {
  autoPrint?: boolean;
  agent?: StaffPrintDoc | null;
}) {
  const t = useTranslations("emailInvoice");
  const ts = useTranslations("staffPrint");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{
    tone: "ok" | "warn" | "error";
    text: string;
  } | null>(null);

  useEffect(() => {
    // Ctrl+P, el menú del navegador, o el print() del iframe oculto:
    // antes de paginar, la página a la medida del documento.
    const fit = () => {
      fitPageToContent(document);
    };
    window.addEventListener("beforeprint", fit);
    return () => window.removeEventListener("beforeprint", fit);
  }, []);

  useEffect(() => {
    if (!autoPrint || isEmbeddedFrame()) return;
    // Un beat para que la tirilla termine de pintar antes del diálogo.
    const id = setTimeout(() => printHere(), 400);
    return () => clearTimeout(id);
  }, [autoPrint]);

  async function onClick() {
    if (!agent) {
      printHere();
      return;
    }
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      const result = await printAsStaff(agent, {
        // Sin agente, el respaldo es ESTA página: no hace falta el iframe.
        // El aviso va antes del diálogo (en pantalla; al imprimir no sale).
        onBrowserFallback: (reason) =>
          setNote({
            tone: "warn",
            text: ts(reason === "agent_offline" ? "agentOffline" : "noPrinter"),
          }),
        printInBrowser: async () => {
          printHere();
          return { kind: "printed" };
        },
      });
      if (result.via === "agent") {
        const m = agentMessage(result);
        setNote({ tone: m.tone, text: ts(m.key, m.values) });
      } else if (result.via === "error") {
        setNote({ tone: "error", text: ts("failed") });
      }
    } catch {
      setNote({ tone: "error", text: ts("failed") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" onClick={onClick} disabled={busy}>
        {busy ? ts("sending") : t("print")}
      </button>
      {note && (
        <span role="status" className={`print-note ${note.tone}`}>
          {note.text}
        </span>
      )}
    </>
  );
}

/** Esta misma página, en una sola hoja a la medida del documento. */
function printHere() {
  fitPageToContent(document);
  window.print();
}
