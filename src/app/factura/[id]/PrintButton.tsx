"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { isEmbeddedFrame, printInBrowserOrOpenTab } from "@/lib/printInBrowser";
import { fitPageToContent } from "@/lib/print/fitPageToContent";
import {
  agentMessage,
  printAsStaff,
  type StaffPrintDeps,
  type StaffPrintDoc,
} from "@/lib/print/staffPrint";
import {
  DEVICE_PAPER_PARAM,
  devicePaperFromParam,
  devicePrintHelpHref,
} from "@/lib/print/printDestination";
import {
  PrintDestinationPicker,
  usePrintPreference,
  type PrintViewer,
} from "@/components/print/PrintDestinationPicker";
import {
  printOnTerminal,
  readRememberedPrintTerminal,
  rememberPrintTerminal,
  terminalPrintMessage,
  type TerminalPrintDevice,
} from "@/lib/print/terminalPrintClient";

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
 * arriba, «Imprimir en: Impresora de caja · Este dispositivo» (recordado
 * en el equipo, ver `printDestination.ts`).
 *   - Impresora de caja: el botón manda el documento al AGENTE, como las
 *     comandas, y dice por cuál impresora salió; si el local no tiene
 *     impresora de facturas (o su agente no responde), imprime esta misma
 *     página como siempre.
 *   - Este dispositivo: imprime acá, al papel del equipo. Si esta página
 *     ya está a ese ancho, la misma página; si no, la tirilla a ese ancho
 *     en el iframe oculto (`?w=55`).
 * Sin `agent` (el comensal) imprime esta página y nada más.
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
  paperMm = null,
  viewer = null,
}: {
  autoPrint?: boolean;
  agent?: StaffPrintDoc | null;
  /** El ancho al que está dibujada esta página (58 u 80). */
  paperMm?: number | null;
  /** Rol y comercio de quien mira (del servidor): el destino sale sin esperar. */
  viewer?: PrintViewer | null;
}) {
  const t = useTranslations("emailInvoice");
  const ts = useTranslations("staffPrint");
  const pref = usePrintPreference(viewer);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{
    tone: "ok" | "warn" | "error";
    text: string;
    /** La guía de «Este dispositivo», si quien mira puede abrirla. */
    help?: string | null;
    /** «Datáfono»: hay varios y hay que decir cuál (una vez). */
    chooseDevices?: TerminalPrintDevice[];
    /** «Datáfono»: quedó encolada sin imprimir; reintentar con el mismo trabajo. */
    retryJob?: { deviceId: string; printJobId: string };
  } | null>(null);

  /**
   * «Datáfono» (y «Este dispositivo» del usuario Datáfono): la impresora del
   * datáfono Kushki, por el servidor (`/api/operator/print/terminal`).
   */
  async function sendToTerminal(doc: StaffPrintDoc, deviceId?: string, printJobId?: string) {
    setBusy(true);
    setNote({ tone: "ok", text: ts("terminalSending") });
    try {
      const r = await printOnTerminal(doc, {
        deviceId: deviceId ?? readRememberedPrintTerminal(pref.scope),
        printJobId,
      });
      if (r.via === "terminal") {
        rememberPrintTerminal(pref.scope, r.deviceId);
        // «Impresa ✓» sólo si el datáfono respondió COMPLETED.
        setNote(
          r.state === "printed"
            ? { tone: "ok", text: ts("terminalSent", { device: r.deviceLabel }) }
            : {
                tone: "warn",
                text: ts("terminalQueued", { device: r.deviceLabel }),
                retryJob: { deviceId: r.deviceId, printJobId: r.printJobId },
              },
        );
      } else if (r.via === "choose_device") {
        setNote({ tone: "warn", text: ts("terminalChoose"), chooseDevices: r.devices });
      } else {
        const m = terminalPrintMessage(r.code, r.reason, r.errorCode);
        setNote({ tone: "error", text: ts(m.key, m.values) });
      }
    } catch {
      setNote({ tone: "error", text: ts("terminalFailed") });
    } finally {
      setBusy(false);
    }
  }

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
    if (busy || !pref.ready) return;
    const destination = pref.destination;
    if (destination === "terminal" || (destination === "device" && pref.role === "terminal")) {
      await sendToTerminal(agent);
      return;
    }
    setBusy(true);
    setNote(null);
    const deps: StaffPrintDeps =
      destination === "device"
        ? {
            onDevicePrint: () => setNote({ tone: "ok", text: ts("deviceOpening") }),
            // Esta página ya está al papel del equipo: se imprime ella. Si
            // no, la tirilla a ese ancho, en el iframe oculto.
            printInBrowser: async (url, options) => {
              const target = new URL(url, window.location.href);
              if (devicePaperFromParam(target.searchParams.get(DEVICE_PAPER_PARAM)) === paperMm) {
                printHere();
                return { kind: "printed" };
              }
              return printInBrowserOrOpenTab(url, options);
            },
          }
        : {
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
          };
    try {
      const result = await printAsStaff(agent, deps, {
        destination,
        paperMm: pref.paperMm,
      });
      if (result.via === "agent") {
        const m = agentMessage(result);
        setNote({ tone: m.tone, text: ts(m.key, m.values) });
      } else if (result.via === "device") {
        setNote(
          result.outcome.kind === "printed"
            ? {
                tone: "ok",
                text: ts("deviceOpened", { mm: result.paperMm }) + " " + ts("deviceHint"),
                help: devicePrintHelpHref(pref.role),
              }
            : { tone: "error", text: ts("failed") },
        );
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
      {agent && (
        <PrintDestinationPicker pref={pref} disabled={busy} variant="receipt" className="print-dest" />
      )}
      <button type="button" onClick={onClick} disabled={busy || (!!agent && !pref.ready)}>
        {busy ? ts("sending") : t("print")}
      </button>
      {note && (
        <span role="status" className={`print-note ${note.tone}`}>
          {note.text}
          {note.help && (
            <>
              {" "}
              <a href={note.help} className="print-help">
                {ts("deviceHelpLink")}
              </a>
            </>
          )}
          {agent && note.retryJob && (
            <>
              {" "}
              <a
                href="#"
                className="print-help"
                onClick={(e) => {
                  e.preventDefault();
                  void sendToTerminal(agent, note.retryJob!.deviceId, note.retryJob!.printJobId);
                }}
              >
                {ts("retry")}
              </a>
            </>
          )}
          {agent &&
            note.chooseDevices?.map((d, i) => (
              <a
                key={d.id}
                href="#"
                className="print-help"
                style={{ marginLeft: i === 0 ? "0.5em" : "0.75em" }}
                onClick={(e) => {
                  e.preventDefault();
                  rememberPrintTerminal(pref.scope, d.id);
                  void sendToTerminal(agent, d.id);
                }}
              >
                {d.label}
              </a>
            ))}
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
