"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { isEmbeddedFrame } from "@/lib/printInBrowser";
import { fitPageToContent } from "@/lib/print/fitPageToContent";
import {
  DEVICE_PRINT_BODY,
  agentMessage,
  notifiesDevicePrint,
  printAsStaff,
  staffPrintEndpoint,
  type StaffPrintDoc,
} from "@/lib/print/staffPrint";
import { DEVICE_PAPER_MM, devicePrintHelpHref } from "@/lib/print/printDestination";
import {
  printDocumentOnDevice,
  reportClientPrintError,
  watchPrintDialog,
} from "@/lib/print/devicePrint";
import {
  printOnTerminal,
  readRememberedPrintTerminal,
  rememberPrintTerminal,
  terminalPrintMessage,
  type TerminalPrintDevice,
} from "@/lib/print/terminalPrintClient";
import {
  PrintDestinationPicker,
  usePrintPreference,
  type PrintViewer,
} from "@/components/print/PrintDestinationPicker";

type Note = {
  tone: "ok" | "warn" | "error";
  text: string;
  /** La guía de «Este dispositivo», si quien mira puede abrirla. */
  help?: string | null;
  /** El navegador no imprimió: ofrecer el datáfono (Kushki) y la caja. */
  alternatives?: boolean;
  /** Datáfono: hay varios y hay que decir cuál es éste. */
  chooseDevices?: TerminalPrintDevice[];
};

/**
 * Botón "Imprimir" de las vistas imprimibles (la factura `/factura/[id]`,
 * la precuenta y la tirilla del cierre de turno).
 *
 * Al imprimir desde ESTA página, primero `fitPageToContent`: una sola
 * página del alto del documento, para que el driver de la térmica no la
 * corte en dos tiras. También con Ctrl+P (`beforeprint`).
 *
 * `agent` (sólo cuando mira el STAFF del comercio, lo decide el server):
 * arriba, «Imprimir en: Impresora de caja · Este dispositivo» (recordado
 * en el equipo, ver `printDestination.ts`).
 *   - Impresora de caja: el botón manda el documento al AGENTE, como las
 *     comandas, y dice por cuál impresora salió; si el local no tiene
 *     impresora de facturas (o su agente no responde), imprime esta misma
 *     página como siempre.
 *   - Este dispositivo: `window.print()` de ESTA página, a 55 mm, dentro del
 *     mismo toque y sin esperar nada antes (`printDocumentOnDevice`). Si el
 *     navegador no puede (Firefox para Android < 114, la app instalada del
 *     datáfono) o no abrió el diálogo, se dice qué hacer y se ofrece el
 *     datáfono (Kushki) o la caja. El usuario Datáfono imprime directo en su
 *     Smart POS por Kushki.
 * Sin `agent` (el comensal) imprime esta página y nada más.
 *
 * `deviceView` (llegó con `?imprimir=dispositivo` desde un botón de otra
 * pantalla): el destino es este dispositivo, sin selector, con la pista y
 * «Volver». No se imprime solo: los navegadores móviles piden el toque.
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
  viewer = null,
  deviceView = false,
}: {
  autoPrint?: boolean;
  agent?: StaffPrintDoc | null;
  /** Rol y comercio de quien mira (del servidor): el destino sale sin esperar. */
  viewer?: PrintViewer | null;
  /** Llegó para «Este dispositivo» (`?imprimir=dispositivo`). */
  deviceView?: boolean;
}) {
  const t = useTranslations("emailInvoice");
  const ts = useTranslations("staffPrint");
  const pref = usePrintPreference(viewer);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const stopWatch = useRef<(() => void) | null>(null);

  useEffect(() => {
    // Ctrl+P, el menú del navegador, o el print() del iframe oculto:
    // antes de paginar, la página a la medida del documento.
    const fit = () => {
      fitPageToContent(document);
    };
    window.addEventListener("beforeprint", fit);
    return () => {
      window.removeEventListener("beforeprint", fit);
      stopWatch.current?.();
    };
  }, []);

  useEffect(() => {
    if (!autoPrint || isEmbeddedFrame()) return;
    // Un beat para que la tirilla termine de pintar antes del diálogo.
    const id = setTimeout(() => printHere(), 400);
    return () => clearTimeout(id);
  }, [autoPrint]);

  const destination = deviceView ? "device" : pref.destination;
  const isTerminal = pref.role === "terminal";

  /**
   * «Este dispositivo» en el navegador: SÍNCRONO, dentro del toque. El
   * rastro (precuenta, cierre) se manda después, sin esperarlo.
   */
  function printOnThisDevice(doc: StaffPrintDoc) {
    stopWatch.current?.();
    const outcome = printDocumentOnDevice();
    if (outcome.kind === "unsupported") {
      reportClientPrintError("device_print_unsupported");
      setNote({ tone: "warn", text: ts("deviceUnsupported"), alternatives: true, help: devicePrintHelpHref(pref.role) });
      return;
    }
    if (outcome.kind === "error") {
      reportClientPrintError("device_print_failed", { name: outcome.name, message: outcome.message });
      setNote({ tone: "error", text: ts("deviceBrowserError"), alternatives: true, help: devicePrintHelpHref(pref.role) });
      return;
    }
    setNote({
      tone: "ok",
      text: ts("deviceOpened", { mm: DEVICE_PAPER_MM }) + " " + ts("deviceHint"),
      help: devicePrintHelpHref(pref.role),
    });
    stopWatch.current = watchPrintDialog(window, () => {
      reportClientPrintError("device_print_no_dialog");
      setNote({ tone: "warn", text: ts("deviceNoDialog"), alternatives: true, help: devicePrintHelpHref(pref.role) });
    });
    if (notifiesDevicePrint(doc)) {
      void fetch(staffPrintEndpoint(doc), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: DEVICE_PRINT_BODY,
        keepalive: true,
      }).catch(() => undefined);
    }
  }

  /** En el datáfono (Kushki): el Smart POS imprime; aquí, el aviso. */
  async function sendToTerminal(doc: StaffPrintDoc, deviceId?: string) {
    if (busy) return;
    setBusy(true);
    setNote({ tone: "ok", text: ts("terminalSending") });
    try {
      const r = await printOnTerminal(doc, { deviceId: deviceId ?? readRememberedPrintTerminal(pref.scope) });
      if (r.via === "terminal") {
        rememberPrintTerminal(pref.scope, r.deviceId);
        setNote({ tone: "ok", text: ts("terminalSent", { device: r.deviceLabel }) });
      } else if (r.via === "choose_device") {
        setNote({ tone: "warn", text: ts("terminalChoose"), chooseDevices: r.devices });
      } else {
        reportClientPrintError("terminal_print_failed", { name: r.code ?? "unknown", ...(r.reason && { message: r.reason }) });
        const m = terminalPrintMessage(r.code, r.reason);
        setNote({ tone: "error", text: ts(m.key, m.values) });
      }
    } catch {
      setNote({ tone: "error", text: ts("terminalFailed") });
    } finally {
      setBusy(false);
    }
  }

  async function sendToCaja(doc: StaffPrintDoc) {
    setBusy(true);
    setNote(null);
    try {
      const result = await printAsStaff(
        doc,
        {
          // Sin agente, el respaldo es ESTA página: no hace falta el iframe.
          // El aviso va antes del diálogo (en pantalla; al imprimir no sale).
          onBrowserFallback: (reason) =>
            setNote({ tone: "warn", text: ts(reason === "agent_offline" ? "agentOffline" : "noPrinter") }),
          printInBrowser: async () => {
            printHere();
            return { kind: "printed" };
          },
        },
        { destination: "caja" },
      );
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

  function onClick() {
    if (!agent) {
      printHere();
      return;
    }
    if (busy || !pref.ready) return;
    // «Datáfono» (y «Este dispositivo» del usuario Datáfono): Kushki.
    if (destination === "terminal" || (destination === "device" && isTerminal)) {
      void sendToTerminal(agent);
      return;
    }
    if (destination === "device") {
      printOnThisDevice(agent);
      return;
    }
    void sendToCaja(agent);
  }

  return (
    <>
      {agent && !deviceView && (
        <PrintDestinationPicker pref={pref} disabled={busy} variant="receipt" className="print-dest" />
      )}
      {agent && deviceView && <span className="print-note">{ts("deviceViewHint")}</span>}
      <button type="button" onClick={onClick} disabled={busy || (!!agent && !pref.ready)}>
        {busy ? ts("sending") : t("print")}
      </button>
      {agent && deviceView && (
        <button type="button" className="secondary-btn" onClick={() => window.history.back()}>
          {ts("back")}
        </button>
      )}
      {note && (
        <span role="status" className={`print-note ${note.tone}`}>
          {note.text}
          {agent && note.alternatives && (
            <>
              {" "}
              {pref.terminalDevices.length > 0 && (
                <>
                  <a
                    href="#"
                    className="print-help"
                    onClick={(e) => {
                      e.preventDefault();
                      void sendToTerminal(agent);
                    }}
                  >
                    {ts("useTerminal")}
                  </a>
                  {" · "}
                </>
              )}
              <a
                href="#"
                className="print-help"
                onClick={(e) => {
                  e.preventDefault();
                  pref.setDestination("caja");
                  void sendToCaja(agent);
                }}
              >
                {ts("useCaja")}
              </a>
            </>
          )}
          {note.help && (
            <>
              {" · "}
              <a href={note.help} className="print-help">
                {ts("deviceHelpLink")}
              </a>
            </>
          )}
          {agent && note.chooseDevices && note.chooseDevices.length > 0 && (
            <>
              {" "}
              {note.chooseDevices.map((d, i) => (
                <a
                  key={d.id}
                  style={i > 0 ? { marginLeft: "0.75em" } : undefined}
                  href="#"
                  className="print-help"
                  onClick={(e) => {
                    e.preventDefault();
                    rememberPrintTerminal(pref.scope, d.id);
                    void sendToTerminal(agent, d.id);
                  }}
                >
                  {d.label}
                </a>
              ))}
            </>
          )}
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
