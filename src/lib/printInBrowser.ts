/**
 * Impresión "desde la misma página": carga una URL PROPIA (mismo origen) en
 * un <iframe> oculto y abre el diálogo de impresión del navegador sobre ese
 * documento. Es el respaldo de "Reimprimir factura" e "Imprimir precuenta"
 * cuando el local no tiene impresora de facturas (o su agente no responde).
 *
 * Por qué NO `window.open(url, "_blank")`, que era lo que hacíamos:
 *  - deja una pestaña abierta que alguien tiene que cerrar; en caja, con la
 *    fila de la tarde, es una pestaña más por cada factura reimpresa;
 *  - Safari (y Chrome con bloqueador) lo tratan como popup cuando llega
 *    después de un `await` —nuestro POST a la API— y lo bloquean;
 *  - el foco se va a la pestaña nueva y se pierde la pantalla en la que se
 *    estaba trabajando (la lista de pedidos, el detalle de la mesa).
 *
 * Con el iframe el documento se carga "por debajo", el diálogo sale sobre
 * la página actual y, al cerrarse (`afterprint`), el iframe se retira solo.
 * Es el mismo mecanismo con el que ya imprime la pantalla de cocina
 * (`operator/print/[station]/PrintListener`), sólo que con una URL en vez
 * de `srcdoc`. En Safari iOS `contentWindow.print()` también funciona en
 * iframes del mismo origen; si un navegador tira al llamarlo, el que llama
 * puede caer a la pestaña de siempre (`printInBrowserOrOpenTab`).
 *
 * Contrato con la página imprimible:
 *  - marca su contenido con `data-print-document`: así se distingue un
 *    404/500 (Next devuelve una página de error con `load` normal) o un
 *    rebote al login de un documento de verdad;
 *  - NO se auto-imprime cuando está embebida (`isEmbeddedFrame()`): acá
 *    imprime el helper, y si la página también lo hiciera saldrían dos
 *    diálogos.
 *
 * El DOM entra por `PrintFrameEnv` (por defecto, el navegador) para poder
 * probar el flujo entero en vitest con entorno `node`, sin jsdom.
 */

export type PrintInBrowserReason =
  /** La URL no es de este origen: un iframe ajeno no se puede imprimir. */
  | "cross_origin"
  /** El documento no cargó como imprimible (404/500, login, error de red). */
  | "load_failed"
  /** El documento nunca terminó de cargar. */
  | "timeout"
  /** El navegador tiró al llamar `print()` (bloqueado / no soportado). */
  | "blocked"
  /** Llegó otra impresión antes de que ésta cargara. */
  | "superseded"
  /** `cancelHiddenFramePrint()`. */
  | "cancelled";

export class PrintInBrowserError extends Error {
  readonly reason: PrintInBrowserReason;
  constructor(reason: PrintInBrowserReason) {
    super(`printInBrowser: ${reason}`);
    this.name = "PrintInBrowserError";
    this.reason = reason;
  }
}

/** Lo que el helper necesita de la ventana del iframe una vez cargado. */
export interface PrintFrameWindow {
  focus(): void;
  print(): void;
  addEventListener(type: "afterprint", listener: () => void): void;
}

export interface PrintFrameDocument {
  querySelector(selectors: string): unknown;
}

/** Subconjunto de HTMLIFrameElement que usa el helper (para poder fingirlo). */
export interface PrintFrameElement {
  src: string;
  tabIndex: number;
  style: { cssText: string };
  setAttribute(name: string, value: string): void;
  addEventListener(type: "load" | "error", listener: () => void): void;
  removeEventListener(type: "load" | "error", listener: () => void): void;
  readonly contentWindow: PrintFrameWindow | null;
  readonly contentDocument: PrintFrameDocument | null;
  remove(): void;
}

export interface PrintFrameEnv {
  /** `location.origin`: sólo se imprimen documentos de este origen. */
  origin: string;
  /** `location.href`: base para resolver URLs relativas. */
  href: string;
  /** Crea el iframe (todavía sin montar). */
  createFrame(): PrintFrameElement;
  /** Lo cuelga del documento: ahí arranca la carga. */
  mount(frame: PrintFrameElement): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

export interface PrintInHiddenFrameOptions {
  env?: PrintFrameEnv;
  /** Selector que debe existir en el documento cargado. */
  readySelector?: string;
  /** Cuánto esperar el `load` antes de rendirse. */
  loadTimeoutMs?: number;
  /** Cuánto dejar vivo el iframe si `afterprint` nunca llega. */
  cleanupTimeoutMs?: number;
}

/** Atributo con el que la página imprimible marca su documento. */
export const PRINT_DOCUMENT_ATTR = "data-print-document";
const DEFAULT_LOAD_TIMEOUT_MS = 30_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 60_000;

// Fuera de pantalla, NO `display:none`: sin maquetar, Chrome y Firefox
// imprimen el documento en blanco. Mismo criterio que el iframe de cocina.
const HIDDEN_FRAME_CSS =
  "position:fixed;left:-9999px;top:0;width:400px;height:800px;border:0;";

/** El iframe vivo, si hay uno: un solo iframe a la vez. */
let active: {
  frame: PrintFrameElement;
  abort: (reason: PrintInBrowserReason) => void;
} | null = null;

function browserEnv(): PrintFrameEnv {
  return {
    origin: window.location.origin,
    href: window.location.href,
    createFrame: () => document.createElement("iframe"),
    mount: (frame) => {
      document.body.appendChild(frame as HTMLIFrameElement);
    },
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (id) => window.clearTimeout(id as number),
  };
}

/**
 * ¿Esta página está embebida en un iframe (el nuestro o cualquier otro)?
 * Las páginas que se auto-imprimen con `?print=1` lo consultan para NO
 * hacerlo cuando las imprime el helper.
 */
export function isEmbeddedFrame(
  win: { self: unknown; top: unknown } = window,
): boolean {
  try {
    return win.self !== win.top;
  } catch {
    // Si ni siquiera se puede mirar `top`, hay un padre de otro origen.
    return true;
  }
}

/** Retira el iframe activo (si lo hay); su promesa, si seguía cargando, se rechaza. */
export function cancelHiddenFramePrint(): void {
  active?.abort("cancelled");
}

/**
 * Carga `url` en un iframe oculto y, cuando el documento está listo, llama
 * `focus()` + `print()` sobre él. Resuelve apenas el navegador tomó la
 * impresión (en escritorio `print()` bloquea hasta cerrar el diálogo, así
 * que resolver ≈ diálogo cerrado; en iOS vuelve enseguida). El iframe se
 * retira con `afterprint`, o a los 60 s si el navegador no avisa.
 *
 * Rechaza con `PrintInBrowserError` (ver `reason`): otro origen, documento
 * que no cargó como imprimible (404/500, login), timeout de carga, navegador
 * que tiró al imprimir, o una impresión posterior que la reemplazó.
 */
export function printUrlInHiddenFrame(
  url: string,
  options: PrintInHiddenFrameOptions = {},
): Promise<void> {
  const env = options.env ?? browserEnv();
  const readySelector = options.readySelector ?? `[${PRINT_DOCUMENT_ATTR}]`;
  const loadTimeoutMs = options.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS;
  const cleanupTimeoutMs =
    options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;

  return new Promise<void>((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(url, env.href);
    } catch {
      reject(new PrintInBrowserError("cross_origin"));
      return;
    }
    if (target.origin !== env.origin) {
      reject(new PrintInBrowserError("cross_origin"));
      return;
    }

    // Un solo iframe a la vez: si quedó uno (cargando, o ya impreso pero
    // sin `afterprint` todavía) se retira. En escritorio `print()` bloquea
    // hasta cerrar el diálogo, así que si hubo otro clic ese diálogo ya se
    // cerró; en iOS la hoja de impresión es modal y no se puede clicar.
    active?.abort("superseded");

    const frame = env.createFrame();
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.style.cssText = HIDDEN_FRAME_CSS;

    let settled = false;
    let loadTimer: unknown = null;
    let cleanupTimer: unknown = null;

    function teardown() {
      if (loadTimer !== null) env.clearTimeout(loadTimer);
      if (cleanupTimer !== null) env.clearTimeout(cleanupTimer);
      loadTimer = null;
      cleanupTimer = null;
      frame.removeEventListener("load", onLoad);
      frame.removeEventListener("error", onError);
      frame.remove();
      if (active?.frame === frame) active = null;
    }

    function fail(reason: PrintInBrowserReason) {
      teardown();
      if (settled) return;
      settled = true;
      reject(new PrintInBrowserError(reason));
    }

    function onError() {
      fail("load_failed");
    }

    function onLoad() {
      if (settled) return;
      const win = frame.contentWindow;
      const doc = frame.contentDocument;
      // Sin documento accesible (rebote a otro origen, página de error del
      // navegador) o sin el marcador (404/500 de Next, login): no es lo que
      // había que imprimir.
      if (!win || !doc || !doc.querySelector(readySelector)) {
        fail("load_failed");
        return;
      }
      if (loadTimer !== null) {
        env.clearTimeout(loadTimer);
        loadTimer = null;
      }
      // El iframe se va cuando se cierra el diálogo; y si el navegador no
      // avisa (`afterprint` no es universal), a los 60 s.
      win.addEventListener("afterprint", teardown);
      cleanupTimer = env.setTimeout(teardown, cleanupTimeoutMs);
      try {
        win.focus();
        win.print();
      } catch {
        fail("blocked");
        return;
      }
      settled = true;
      resolve();
    }

    frame.addEventListener("load", onLoad);
    frame.addEventListener("error", onError);
    loadTimer = env.setTimeout(() => fail("timeout"), loadTimeoutMs);
    active = { frame, abort: fail };
    frame.src = target.href;
    env.mount(frame);
  });
}

export type BrowserPrintOutcome =
  /** El diálogo de impresión salió sobre esta misma página. */
  | { kind: "printed" }
  /**
   * El navegador no dejó imprimir embebido: se abrió la página aparte
   * (último recurso, lo de antes). `blocked` si tampoco dejó abrirla.
   */
  | { kind: "tab"; blocked: boolean }
  /** El documento no cargó: no tiene sentido abrirlo en pestaña. */
  | { kind: "failed"; reason: PrintInBrowserReason };

export interface PrintInBrowserOrTabOptions extends PrintInHiddenFrameOptions {
  /** URL de la pestaña de respaldo (p. ej. con `?print=1`); por defecto la misma. */
  tabUrl?: string;
  /** Abre la pestaña; devuelve false si el navegador la bloqueó. */
  openTab?: (url: string) => boolean;
}

function openTabInBrowser(url: string): boolean {
  // Sin `noopener` a propósito: con esa opción `window.open` devuelve null
  // aunque abra, y acá el null es la señal de bloqueo. La página es propia.
  return window.open(url, "_blank") !== null;
}

/**
 * Respaldo completo: imprime en el iframe oculto y, SÓLO si el navegador no
 * deja imprimir embebido (`print()` tiró, o algo inesperado), cae a abrir
 * la página en una pestaña como antes. Un documento que no cargó no se
 * abre en pestaña: tampoco cargaría ahí.
 */
export async function printInBrowserOrOpenTab(
  url: string,
  options: PrintInBrowserOrTabOptions = {},
): Promise<BrowserPrintOutcome> {
  const { tabUrl = url, openTab = openTabInBrowser, ...frameOptions } = options;
  try {
    await printUrlInHiddenFrame(url, frameOptions);
    return { kind: "printed" };
  } catch (err) {
    const reason: PrintInBrowserReason =
      err instanceof PrintInBrowserError ? err.reason : "blocked";
    if (reason !== "blocked") return { kind: "failed", reason };
    return { kind: "tab", blocked: !openTab(tabUrl) };
  }
}
