"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
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
import {
  printOnTerminal,
  readRememberedPrintTerminal,
  rememberPrintTerminal,
  terminalPrintMessage,
  type TerminalPrintDevice,
} from "@/lib/print/terminalPrintClient";
import { browserPrintSupport, reportClientPrintError } from "@/lib/print/devicePrint";
import {
  devicePrintHelpHref,
  otherDestination,
  type PrintDestination,
} from "@/lib/print/printDestination";
import {
  PrintDestinationPicker,
  usePrintPreference,
  type PrintDestinationVariant,
  type PrintPreferenceState,
  type PrintViewer,
} from "./PrintDestinationPicker";

export type StaffPrintTone = "ok" | "warn" | "error";
type Tone = StaffPrintTone;

type Notice = {
  tone: Tone;
  text: string;
  /** Por qué se cayó al navegador (para el aviso de configurar). */
  fallback?: StaffPrintFallbackReason;
  /**
   * «Este dispositivo» en un navegador que no puede imprimir: el aviso
   * ofrece imprimir en el datáfono (Kushki) o en la caja.
   */
  device?: { unsupported: boolean };
  /** A dónde se intentó: para ofrecer «Reintentar» y el otro destino. */
  destination?: PrintDestination;
  /** Datáfono: hay varios y hay que decir cuál es éste (una vez). */
  chooseDevices?: TerminalPrintDevice[];
  /** Datáfono: quedó encolada sin imprimir; reintentar con el MISMO trabajo. */
  retryJob?: { deviceId: string; printJobId: string };
};

/**
 * Botón "Imprimir factura" (o precuenta, o cierre) del STAFF, con el
 * selector «Imprimir en: Impresora de caja · Este dispositivo» encima (ver
 * `lib/print/printDestination.ts`; se recuerda por equipo y comercio).
 *
 *   - Impresora de caja: por el AGENTE, como las comandas, y el navegador
 *     sólo como respaldo (ver `staffPrint.ts`). Sin cambios.
 *   - Este dispositivo: la tirilla al ancho del papel del equipo, en el
 *     diálogo de impresión de este navegador (en el datáfono Sunmi, su
 *     impresora integrada).
 *
 * Debajo, en una línea, lo que pasó: "Enviada a Caja ✓" (se va sola), que
 * salió el comprobante porque la DIAN todavía no aceptó la electrónica,
 * que no hay impresora de facturas y se imprime desde el navegador, o que
 * se abrió la impresión de este dispositivo (con cómo activar la impresora
 * del equipo si no aparece). Si falla, «Reintentar» y la opción de imprimir
 * por el otro destino.
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
  showDestination = true,
  destinationVariant = "op",
  destinationClassName = "",
  viewer,
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
  /** Mostrar «Imprimir en: …» encima del botón. */
  showDestination?: boolean;
  destinationVariant?: PrintDestinationVariant;
  destinationClassName?: string;
  /** Rol y comercio de quien mira, si la pantalla ya los sabe. */
  viewer?: PrintViewer | null;
}) {
  const t = useTranslations("staffPrint");
  const print = useStaffPrint(doc, { openTab, viewer });
  return (
    <>
      {showDestination && (
        <PrintDestinationPicker
          pref={print.pref}
          disabled={print.busy}
          variant={destinationVariant}
          className={destinationClassName}
        />
      )}
      <button
        type="button"
        onClick={() => void print.run()}
        disabled={print.busy || !print.pref.ready}
        className={className}
      >
        {print.busy ? t("sending") : label}
      </button>
      <StaffPrintNotice
        print={print}
        className={statusClassName}
        sameTab={sameTab}
        canConfigurePrinters={canConfigurePrinters}
      />
    </>
  );
}

export type StaffPrintState = {
  /** Imprime en el destino elegido en este equipo. */
  run: () => Promise<void>;
  /** Imprime en `destination` sin cambiar lo elegido («Reintentar»). */
  runAt: (destination: PrintDestination) => Promise<void>;
  /** Cambia el destino recordado e imprime ahí. */
  switchTo: (destination: PrintDestination) => Promise<void>;
  /** Datáfono: elige cuál es este equipo e imprime ahí. */
  chooseTerminal: (deviceId: string) => Promise<void>;
  /** Imprime en el datáfono por Kushki (también desde otros roles, como salida). */
  runOnTerminal: () => Promise<void>;
  /** Datáfono: reintenta un trabajo encolado (el mismo `printJobId`). */
  retryTerminal: (job: { deviceId: string; printJobId: string }) => Promise<void>;
  busy: boolean;
  notice: Notice | null;
  browser: BrowserPrintState | null;
  pref: PrintPreferenceState;
};

/**
 * La lógica del botón, sin el botón: para disparar la misma impresión
 * desde otro control (el menú «⋯» de una fila de Facturas) y mostrar el
 * aviso donde convenga con <StaffPrintNotice>. Imprime en el destino
 * recordado en este equipo.
 */
export function useStaffPrint(
  doc: StaffPrintDoc,
  {
    openTab,
    viewer,
  }: {
    openTab?: (url: string) => boolean;
    /** El rol y el comercio, si la pantalla ya los sabe (si no, la sesión). */
    viewer?: PrintViewer | null;
  } = {},
): StaffPrintState {
  const t = useTranslations("staffPrint");
  const pref = usePrintPreference(viewer);
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

  /**
   * «Este dispositivo» del usuario DATÁFONO: la impresora integrada del
   * Smart POS por el Print API cloud de Kushki (su app instalada en Firefox
   * no abre la impresión del sistema). Ver `lib/print/terminalPrint.ts`.
   */
  /**
   * «Datáfono» (y «Este dispositivo» del usuario Datáfono): la impresora del
   * datáfono por Kushki (ver `lib/print/terminalPrint.ts`). «Impresa ✓» sólo
   * si el datáfono respondió COMPLETED; si quedó encolada, Reintentar con el
   * MISMO trabajo (no imprime doble).
   */
  async function runOnTerminal(deviceId?: string, printJobId?: string) {
    if (busy) return;
    if (timer.current) clearTimeout(timer.current);
    setBusy(true);
    setBrowser(null);
    // El destino con el que se reintenta: «Datáfono», o el «Este
    // dispositivo» del usuario Datáfono.
    const dest: PrintDestination = pref.role === "terminal" ? "device" : "terminal";
    setNotice({ tone: "ok", text: t("terminalSending"), destination: dest });
    const scope = pref.scope;
    try {
      const result = await printOnTerminal(doc, {
        deviceId: deviceId ?? readRememberedPrintTerminal(scope),
        printJobId,
      });
      if (result.via === "terminal") {
        rememberPrintTerminal(scope, result.deviceId);
        setNotice(
          result.state === "printed"
            ? { tone: "ok", text: t("terminalSent", { device: result.deviceLabel }), destination: dest }
            : {
                tone: "warn",
                text: t("terminalQueued", { device: result.deviceLabel }),
                destination: dest,
                retryJob: { deviceId: result.deviceId, printJobId: result.printJobId },
              },
        );
      } else if (result.via === "choose_device") {
        setNotice({ tone: "warn", text: t("terminalChoose"), destination: dest, chooseDevices: result.devices });
      } else {
        reportClientPrintError("terminal_print_failed", {
          name: result.errorCode ?? result.code ?? "unknown",
          ...(result.reason && { message: result.reason }),
        });
        const m = terminalPrintMessage(result.code, result.reason, result.errorCode);
        setNotice({ tone: "error", text: t(m.key, m.values), destination: dest });
      }
    } catch (err) {
      reportClientPrintError("terminal_print_failed", {
        name: err instanceof Error ? err.name : "unknown",
        message: err instanceof Error ? err.message.slice(0, 300) : undefined,
      });
      setNotice({ tone: "error", text: t("terminalFailed"), destination: dest });
    } finally {
      setBusy(false);
    }
  }

  async function runAt(destination: PrintDestination) {
    if (busy || !pref.ready) return;
    // «Datáfono» (y «Este dispositivo» del usuario Datáfono, que es lo
    // mismo): la impresora del Smart POS por Kushki.
    if (destination === "terminal" || (destination === "device" && pref.role === "terminal")) {
      await runOnTerminal();
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    // «Este dispositivo» en un navegador que no puede abrir la impresión
    // del sistema (Firefox para Android < 114, la app instalada del
    // datáfono): ni se navega; se dice qué hacer.
    if (
      destination === "device" &&
      browserPrintSupport(navigator.userAgent, typeof window.print === "function") === "unsupported"
    ) {
      reportClientPrintError("device_print_unsupported");
      setBrowser(null);
      setNotice({ tone: "warn", text: t("deviceUnsupported"), destination, device: { unsupported: true } });
      return;
    }
    setBusy(true);
    setNotice(null);
    setBrowser(null);
    try {
      const result = await printAsStaff(
        doc,
        {
          openTab,
          onBrowserFallback: (reason) => {
            setNotice({
              tone: "warn",
              text: t(reason === "agent_offline" ? "agentOffline" : "noPrinter"),
              fallback: reason,
              destination,
            });
            setBrowser({ step: "preparing" });
          },
          // «Este dispositivo»: a la vista imprimible del equipo (en la PWA
          // del mesero, in-app).
          navigate: (url) => {
            if (!openTab || !openTab(url)) window.location.assign(url);
          },
        },
        { destination },
      );
      if (result.via === "agent") {
        const m = agentMessage(result);
        setNotice({ tone: m.tone, text: t(m.key, m.values), destination: "caja" });
        // El éxito se va solo; el aviso de la DIAN se queda (pide algo).
        if (m.tone === "ok") timer.current = setTimeout(() => setNotice(null), 4000);
      } else if (result.via === "browser") {
        setBrowser(browserPrintStateFrom(result.outcome, result.tabUrl));
      } else if (result.via === "device_view") {
        setBrowser(null);
        setNotice({ tone: "ok", text: t("deviceOpeningView"), destination });
      } else {
        setBrowser(null);
        setNotice({ tone: "error", text: t("failed"), destination });
      }
    } catch {
      setBrowser(null);
      setNotice({ tone: "error", text: t("failed"), destination });
    } finally {
      setBusy(false);
    }
  }

  // Sin argumentos a propósito: se usa directo como `onClick`.
  const run = () => runAt(pref.destination);

  async function switchTo(destination: PrintDestination) {
    pref.setDestination(destination);
    await runAt(destination);
  }

  /** Datáfono: «este datáfono es X» — se recuerda e imprime ahí. */
  async function chooseTerminal(deviceId: string) {
    rememberPrintTerminal(pref.scope, deviceId);
    await runOnTerminal(deviceId);
  }

  return {
    run,
    runAt,
    switchTo,
    chooseTerminal,
    runOnTerminal: () => runOnTerminal(),
    retryTerminal: (job: { deviceId: string; printJobId: string }) => runOnTerminal(job.deviceId, job.printJobId),
    busy,
    notice,
    browser,
    pref,
  };
}

/**
 * El aviso de una impresión del staff (lo que pasó, en una línea) y, si
 * falló, la salida: reintentar o imprimir por el otro destino.
 */
export function StaffPrintNotice({
  print,
  className = "block text-[11px]",
  sameTab = false,
  canConfigurePrinters = false,
}: {
  print: Pick<
    StaffPrintState,
    | "notice"
    | "browser"
    | "busy"
    | "runAt"
    | "switchTo"
    | "chooseTerminal"
    | "runOnTerminal"
    | "retryTerminal"
    | "pref"
  >;
  className?: string;
  sameTab?: boolean;
  canConfigurePrinters?: boolean;
}) {
  const t = useTranslations("staffPrint");
  const { notice, browser } = print;
  if (!notice) return null;
  const failed = notice.tone === "error" || browser?.step === "error";
  const unsupported = !!notice.device?.unsupported;
  const helpHref = devicePrintHelpHref(print.pref.role);
  const actionClass = "underline font-medium disabled:opacity-50";
  return (
    <span
      role="status"
      className={
        className +
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
          {notice.text ? " " : null}
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
      {unsupported && (
        <>
          {" "}
          {print.pref.terminalDevices.length > 0 && (
            <>
              <button
                type="button"
                className={actionClass}
                disabled={print.busy}
                onClick={() => void print.runOnTerminal()}
              >
                {t("useTerminal")}
              </button>
              {" · "}
            </>
          )}
          <button
            type="button"
            className={actionClass}
            disabled={print.busy}
            onClick={() => void print.switchTo("caja")}
          >
            {t("useCaja")}
          </button>
          {helpHref && (
            <>
              {" · "}
              <Link href={helpHref} className="underline" prefetch={false}>
                {t("deviceHelpLink")}
              </Link>
            </>
          )}
        </>
      )}
      {failed && notice.destination && (
        <>
          {" "}
          <button
            type="button"
            className={actionClass}
            disabled={print.busy}
            onClick={() => void print.runAt(notice.destination!)}
          >
            {t("retry")}
          </button>
          {" · "}
          <button
            type="button"
            className={actionClass}
            disabled={print.busy}
            onClick={() => void print.switchTo(otherDestination(notice.destination!))}
          >
            {otherDestination(notice.destination) === "caja" ? t("useCaja") : t("useDevice")}
          </button>
        </>
      )}
      {notice.retryJob && (
        <>
          {" "}
          <button
            type="button"
            className={actionClass}
            disabled={print.busy}
            onClick={() => void print.retryTerminal(notice.retryJob!)}
          >
            {t("retry")}
          </button>
          {" · "}
          <button
            type="button"
            className={actionClass}
            disabled={print.busy}
            onClick={() => void print.switchTo("caja")}
          >
            {t("useCaja")}
          </button>
        </>
      )}
      {notice.chooseDevices && notice.chooseDevices.length > 0 && (
        <span className="mt-1 flex flex-wrap gap-1.5">
          {notice.chooseDevices.map((d) => (
            <button
              key={d.id}
              type="button"
              disabled={print.busy}
              onClick={() => void print.chooseTerminal(d.id)}
              className="min-h-9 px-3 rounded-full border border-ink bg-paper text-ink text-xs disabled:opacity-50"
            >
              {d.label}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
