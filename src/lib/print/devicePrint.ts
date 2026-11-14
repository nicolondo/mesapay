/**
 * «Este dispositivo» en el NAVEGADOR (todos los roles menos el datáfono,
 * que imprime por Kushki — `terminalPrint.ts`).
 *
 * Lo que aprendimos en el datáfono real (Firefox para Android 107 como app
 * instalada): imprimir un iframe oculto después de un `await` no sirve en
 * los navegadores móviles. Por eso ahora:
 *
 *   1. Desde una pantalla cualquiera (la ficha de la mesa, Órdenes, el
 *      cierre) NO se imprime ahí: se NAVEGA a la vista imprimible con
 *      `?w=55&imprimir=dispositivo` (`devicePrintViewHref`). Sin auto-print.
 *   2. En la vista imprimible, el botón «Imprimir» llama `window.print()`
 *      del documento de PRIMER NIVEL, dentro del mismo toque, sin esperar
 *      nada antes (`printDocumentOnDevice`): ajusta la tirilla a
 *      `DEVICE_PAPER_MM`, declara la página (`fitPageToContent`, márgenes 0)
 *      e imprime.
 *   3. Detección real: si `window.print` no existe, o es Firefox para
 *      Android anterior a la 114 (donde existe pero no abre nada: Mozilla,
 *      notas de versión 114.0), ni se intenta y se dice qué hacer. Si se
 *      llamó y el navegador no avisó que iba a imprimir (`beforeprint`) en
 *      un rato, se asume que no abrió y también se dice.
 *
 * Todo lo que falla se registra en el servidor (`/api/client-log`) con el
 * user agent, para verlo en los logs.
 *
 * Sólo APIs viejas (Firefox 107, Chrome 99): nada de `Array.at`, `??=`
 * en tiempo de ejecución, `structuredClone`…
 */

import { fitPageToContent } from "./fitPageToContent";
import {
  DEVICE_PAPER_MM,
  DEVICE_PAPER_PARAM,
  receiptSidePaddingMm,
  withQueryParam,
} from "./printDestination";

/** `?imprimir=dispositivo`: la vista imprimible llegó para «Este dispositivo». */
export const DEVICE_VIEW_PARAM = "imprimir";
export const DEVICE_VIEW_VALUE = "dispositivo";

/** La vista imprimible lista para «Este dispositivo» (55 mm, con su botón). */
export function devicePrintViewHref(href: string): string {
  return withQueryParam(
    withQueryParam(href, DEVICE_PAPER_PARAM, String(DEVICE_PAPER_MM)),
    DEVICE_VIEW_PARAM,
    DEVICE_VIEW_VALUE,
  );
}

export function isDevicePrintView(raw: string | string[] | null | undefined): boolean {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v === DEVICE_VIEW_VALUE;
}

/** Firefox para Android imprime con `window.print()` desde la 114. */
export const FIREFOX_ANDROID_PRINT_MIN_VERSION = 114;

/**
 * ¿Este navegador puede abrir la impresión del sistema? `unsupported` si
 * `window.print` no existe o si es Firefox para Android anterior a la 114.
 */
export function browserPrintSupport(
  userAgent: string,
  hasPrint: boolean,
): "supported" | "unsupported" {
  if (!hasPrint) return "unsupported";
  if (/Android/i.test(userAgent)) {
    const m = /Firefox\/(\d+)/.exec(userAgent);
    if (m && Number(m[1]) < FIREFOX_ANDROID_PRINT_MIN_VERSION) return "unsupported";
  }
  return "supported";
}

export type DevicePrintOutcome =
  /** Se llamó `window.print()`: el diálogo debería abrir (ver `watchPrintDialog`). */
  | { kind: "called" }
  /** El navegador no puede: ni se intentó. */
  | { kind: "unsupported" }
  /** `print()` (o el ajuste) tiró. */
  | { kind: "error"; name: string; message: string };

type PrintWindow = {
  print?: () => void;
  navigator: { userAgent: string };
};

/**
 * Imprime ESTE documento (la vista imprimible) a `DEVICE_PAPER_MM`, de
 * forma SÍNCRONA: hay que llamarla directo en el `onClick`. No lanza.
 */
export function printDocumentOnDevice(
  win: PrintWindow & Window = window,
  doc: Document = document,
): DevicePrintOutcome {
  if (browserPrintSupport(win.navigator.userAgent, typeof win.print === "function") === "unsupported") {
    return { kind: "unsupported" };
  }
  try {
    const el = doc.querySelector<HTMLElement>("[data-print-document]");
    if (el) {
      const pad = receiptSidePaddingMm(DEVICE_PAPER_MM);
      el.style.width = `${DEVICE_PAPER_MM}mm`;
      el.style.paddingLeft = `${pad}mm`;
      el.style.paddingRight = `${pad}mm`;
      el.setAttribute("data-print-width-mm", String(DEVICE_PAPER_MM));
    }
    fitPageToContent(doc);
    win.print();
    return { kind: "called" };
  } catch (err) {
    return {
      kind: "error",
      name: err instanceof Error ? err.name : "unknown",
      message: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
    };
  }
}

/**
 * ¿Abrió de verdad? Escucha `beforeprint`/`afterprint` desde ANTES de
 * llamar `print()` (Chrome los dispara dentro de la llamada) y, si en
 * `waitMs` no llegó ninguno, avisa `onNoDialog`. Devuelve cómo dejar de
 * escuchar.
 */
export function watchPrintDialog(
  win: Pick<Window, "addEventListener" | "removeEventListener" | "setTimeout" | "clearTimeout">,
  onNoDialog: () => void,
  waitMs = 2000,
): () => void {
  let seen = false;
  const mark = () => {
    seen = true;
  };
  win.addEventListener("beforeprint", mark);
  win.addEventListener("afterprint", mark);
  const timer = win.setTimeout(() => {
    stop();
    if (!seen) onNoDialog();
  }, waitMs);
  function stop() {
    win.removeEventListener("beforeprint", mark);
    win.removeEventListener("afterprint", mark);
    win.clearTimeout(timer);
  }
  return stop;
}

export type ClientLogEvent =
  | "device_print_failed"
  | "device_print_no_dialog"
  | "device_print_unsupported"
  | "terminal_print_failed";

/**
 * Manda al servidor qué falló (sin datos personales; el user agent lo pone
 * el servidor del encabezado). Nunca lanza ni espera: es un registro.
 */
export function reportClientPrintError(
  event: ClientLogEvent,
  detail: { name?: string; message?: string } = {},
  fetchImpl: typeof fetch | undefined = typeof fetch === "function" ? fetch : undefined,
): void {
  if (!fetchImpl) return;
  try {
    const path = typeof window !== "undefined" ? window.location.pathname : "";
    void fetchImpl("/api/client-log", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event, ...detail, path }),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // Sin red: no hay a quién contarle.
  }
}
