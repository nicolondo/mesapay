import { describe, expect, it, vi } from "vitest";
import {
  browserPrintSupport,
  devicePrintViewHref,
  isDevicePrintView,
  printDocumentOnDevice,
  reportClientPrintError,
  watchPrintDialog,
} from "./devicePrint";

/**
 * «Este dispositivo» en el navegador (todos menos el datáfono). Lo que se
 * blinda, a partir de lo que pasó en el datáfono real (Firefox para
 * Android 107 como app instalada):
 *
 *   · se navega a la vista imprimible (55 mm, `imprimir=dispositivo`);
 *   · ahí `print()` se llama SÍNCRONO, de la página de primer nivel;
 *   · Firefox para Android < 114 (o sin `print`) ni se intenta: se dice;
 *   · si el diálogo no abrió, también se dice; y todo se registra.
 */

const FIREFOX_ANDROID_107 =
  "Mozilla/5.0 (Android 11; Mobile; rv:107.0) Gecko/107.0 Firefox/107.0";
const FIREFOX_ANDROID_120 =
  "Mozilla/5.0 (Android 13; Mobile; rv:120.0) Gecko/120.0 Firefox/120.0";
const CHROME_ANDROID_101 =
  "Mozilla/5.0 (Linux; Android 11; P3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/101.0.4951.41 Mobile Safari/537.36";
const FIREFOX_DESKTOP_107 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:107.0) Gecko/20100101 Firefox/107.0";

describe("¿puede abrir la impresión del sistema?", () => {
  it("Firefox para Android antes de la 114 no (window.print existe pero no abre nada)", () => {
    expect(browserPrintSupport(FIREFOX_ANDROID_107, true)).toBe("unsupported");
    expect(browserPrintSupport(FIREFOX_ANDROID_120, true)).toBe("supported");
  });

  it("Chrome para Android y Firefox de escritorio sí; sin window.print, no", () => {
    expect(browserPrintSupport(CHROME_ANDROID_101, true)).toBe("supported");
    expect(browserPrintSupport(FIREFOX_DESKTOP_107, true)).toBe("supported");
    expect(browserPrintSupport(CHROME_ANDROID_101, false)).toBe("unsupported");
  });
});

describe("la vista imprimible del equipo", () => {
  it("lleva el ancho fijo y la marca de «Este dispositivo»", () => {
    expect(devicePrintViewHref("/factura/inv-1")).toBe("/factura/inv-1?w=55&imprimir=dispositivo");
    expect(devicePrintViewHref("/mesero/precuenta/o-1?print=1")).toBe(
      "/mesero/precuenta/o-1?print=1&w=55&imprimir=dispositivo",
    );
    expect(isDevicePrintView("dispositivo")).toBe(true);
    expect(isDevicePrintView(["dispositivo"])).toBe(true);
    expect(isDevicePrintView(undefined)).toBe(false);
    expect(isDevicePrintView("caja")).toBe(false);
  });
});

/** Un documento mínimo con la tirilla, para ver qué se le hace. */
function fakeDoc() {
  const attrs = new Map<string, string>();
  const el = {
    style: {} as Record<string, string>,
    setAttribute: (k: string, v: string) => attrs.set(k, v),
    getAttribute: (k: string) => attrs.get(k) ?? null,
  };
  return {
    el,
    attrs,
    doc: { querySelector: () => el, querySelectorAll: () => [] } as unknown as Document,
  };
}

describe("imprimir la vista en el equipo", () => {
  it("ajusta la tirilla a 55 mm y llama print() en el mismo toque", () => {
    const { el, attrs, doc } = fakeDoc();
    const print = vi.fn();
    const win = { print, navigator: { userAgent: CHROME_ANDROID_101 } } as unknown as Window;
    expect(printDocumentOnDevice(win, doc)).toEqual({ kind: "called" });
    expect(print).toHaveBeenCalledOnce();
    expect(el.style.width).toBe("55mm");
    expect(el.style.paddingLeft).toBe("3.5mm");
    expect(attrs.get("data-print-width-mm")).toBe("55");
  });

  it("Firefox para Android 107: ni lo intenta", () => {
    const { doc } = fakeDoc();
    const print = vi.fn();
    const win = { print, navigator: { userAgent: FIREFOX_ANDROID_107 } } as unknown as Window;
    expect(printDocumentOnDevice(win, doc)).toEqual({ kind: "unsupported" });
    expect(print).not.toHaveBeenCalled();
  });

  it("si print() tira, lo devuelve con nombre y mensaje (no lanza)", () => {
    const { doc } = fakeDoc();
    const win = {
      print: () => {
        throw new DOMException("not allowed", "NotAllowedError");
      },
      navigator: { userAgent: CHROME_ANDROID_101 },
    } as unknown as Window;
    expect(printDocumentOnDevice(win, doc)).toEqual({ kind: "error", name: "NotAllowedError", message: "not allowed" });
  });
});

describe("¿abrió el diálogo?", () => {
  function fakeWin() {
    const listeners = new Map<string, () => void>();
    let timer: (() => void) | null = null;
    return {
      fire: (type: string) => listeners.get(type)?.(),
      elapse: () => timer?.(),
      win: {
        addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
        removeEventListener: (type: string) => listeners.delete(type),
        setTimeout: (fn: () => void) => {
          timer = fn;
          return 1;
        },
        clearTimeout: () => {
          timer = null;
        },
      } as unknown as Window,
    };
  }

  it("sin beforeprint en el plazo: no abrió", () => {
    const w = fakeWin();
    const onNoDialog = vi.fn();
    watchPrintDialog(w.win, onNoDialog);
    w.elapse();
    expect(onNoDialog).toHaveBeenCalledOnce();
  });

  it("con beforeprint: abrió, no se avisa nada", () => {
    const w = fakeWin();
    const onNoDialog = vi.fn();
    watchPrintDialog(w.win, onNoDialog);
    w.fire("beforeprint");
    w.elapse();
    expect(onNoDialog).not.toHaveBeenCalled();
  });
});

describe("registro de errores del cliente", () => {
  it("manda el evento, el error y la ruta (el user agent lo pone el servidor), sin esperar", () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    reportClientPrintError("device_print_failed", { name: "NotAllowedError", message: "x" }, fetch as unknown as typeof globalThis.fetch);
    expect(fetch).toHaveBeenCalledWith("/api/client-log", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "device_print_failed", name: "NotAllowedError", message: "x", path: "" }),
      keepalive: true,
    });
  });

  it("sin fetch, o si tira, no rompe", () => {
    expect(() => reportClientPrintError("device_print_unsupported", {}, undefined)).not.toThrow();
    expect(() =>
      reportClientPrintError("device_print_unsupported", {}, (() => {
        throw new Error("x");
      }) as unknown as typeof globalThis.fetch),
    ).not.toThrow();
  });
});
