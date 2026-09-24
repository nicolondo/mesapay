import { beforeEach, describe, expect, it } from "vitest";
import {
  PrintInBrowserError,
  cancelHiddenFramePrint,
  isEmbeddedFrame,
  printInBrowserOrOpenTab,
  printUrlInHiddenFrame,
  type PrintFrameElement,
  type PrintFrameEnv,
} from "./printInBrowser";

/**
 * El entorno de vitest es `node` (sin jsdom, y no se agregan dependencias),
 * así que el DOM entra fingido por `PrintFrameEnv`: un iframe de mentira con
 * `contentWindow`/`contentDocument`, timers manuales y un "body" que anota
 * qué se montó. Se ejercita el helper de verdad, no una copia de su lógica:
 * creación y limpieza del iframe, rechazo por carga fallida, bloqueo del
 * navegador, un solo iframe a la vez y la caída a pestaña.
 */

class FakeWindow {
  focused = 0;
  printed = 0;
  throwOnPrint = false;
  private afterprint: Array<() => void> = [];
  focus() {
    this.focused++;
  }
  print() {
    if (this.throwOnPrint) throw new Error("print bloqueado");
    this.printed++;
  }
  addEventListener(_type: "afterprint", listener: () => void) {
    this.afterprint.push(listener);
  }
  fireAfterprint() {
    for (const l of [...this.afterprint]) l();
  }
}

class FakeFrame implements PrintFrameElement {
  src = "";
  tabIndex = 0;
  style = { cssText: "" };
  attrs: Record<string, string> = {};
  removed = false;
  /** Simula un documento inaccesible (rebote a otro origen, error del navegador). */
  detached = false;
  /** Simula un 404/500/login: cargó, pero sin `data-print-document`. */
  hasMarker = true;
  readonly fakeWin = new FakeWindow();
  private listeners: Record<"load" | "error", Array<() => void>> = {
    load: [],
    error: [],
  };
  get contentWindow() {
    return this.detached ? null : this.fakeWin;
  }
  get contentDocument() {
    if (this.detached) return null;
    return {
      querySelector: (sel: string) =>
        sel === "[data-print-document]" && this.hasMarker ? {} : null,
    };
  }
  setAttribute(name: string, value: string) {
    this.attrs[name] = value;
  }
  addEventListener(type: "load" | "error", listener: () => void) {
    this.listeners[type].push(listener);
  }
  removeEventListener(type: "load" | "error", listener: () => void) {
    this.listeners[type] = this.listeners[type].filter((l) => l !== listener);
  }
  remove() {
    this.removed = true;
  }
  fire(type: "load" | "error") {
    for (const l of [...this.listeners[type]]) l();
  }
  get listenerCount() {
    return this.listeners.load.length + this.listeners.error.length;
  }
}

function makeEnv() {
  const frames: FakeFrame[] = [];
  const mounted: FakeFrame[] = [];
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let seq = 0;
  const env: PrintFrameEnv = {
    origin: "https://demo.mesapay.test",
    href: "https://demo.mesapay.test/operator/orders",
    createFrame: () => {
      const f = new FakeFrame();
      frames.push(f);
      return f;
    },
    mount: (frame) => {
      mounted.push(frame as FakeFrame);
    },
    setTimeout: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id as number);
    },
  };
  /** Dispara el timer pendiente de esa duración (el de carga o el de limpieza). */
  const fireTimer = (ms: number) => {
    const entry = [...timers.entries()].find(([, t]) => t.ms === ms);
    if (!entry) throw new Error(`no hay timer de ${ms} ms`);
    timers.delete(entry[0]);
    entry[1].fn();
  };
  return { env, frames, mounted, timers, fireTimer };
}

async function reasonOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "resolved";
  } catch (e) {
    return e instanceof PrintInBrowserError ? e.reason : "other";
  }
}

// Que un test no le deje un iframe vivo al siguiente (el helper guarda el
// activo a nivel de módulo).
beforeEach(() => cancelHiddenFramePrint());

describe("printUrlInHiddenFrame", () => {
  it("monta un iframe oculto con la URL, imprime al cargar y lo retira con afterprint", async () => {
    const { env, frames, mounted, timers } = makeEnv();
    const p = printUrlInHiddenFrame("/factura/abc", { env });
    expect(frames).toHaveLength(1);
    const frame = frames[0];
    expect(mounted).toEqual([frame]);
    expect(frame.src).toBe("https://demo.mesapay.test/factura/abc");
    expect(frame.attrs["aria-hidden"]).toBe("true");
    expect(frame.tabIndex).toBe(-1);
    expect(frame.style.cssText).toContain("left:-9999px");
    expect(frame.style.cssText).not.toContain("display:none");
    // Todavía no imprimió: espera el load.
    expect(frame.fakeWin.printed).toBe(0);

    frame.fire("load");
    await expect(p).resolves.toBeUndefined();
    expect(frame.fakeWin.focused).toBe(1);
    expect(frame.fakeWin.printed).toBe(1);
    // Sigue montado hasta que se cierre el diálogo.
    expect(frame.removed).toBe(false);

    frame.fakeWin.fireAfterprint();
    expect(frame.removed).toBe(true);
    expect(frame.listenerCount).toBe(0);
    expect(timers.size).toBe(0);
  });

  it("si afterprint nunca llega, lo retira a los 60 s", async () => {
    const { env, frames, fireTimer, timers } = makeEnv();
    const p = printUrlInHiddenFrame("/factura/abc", { env });
    frames[0].fire("load");
    await p;
    expect(frames[0].removed).toBe(false);
    fireTimer(60_000);
    expect(frames[0].removed).toBe(true);
    expect(timers.size).toBe(0);
  });

  it("rechaza load_failed si el documento cargó sin el marcador (404/500, login) y no imprime", async () => {
    const { env, frames } = makeEnv();
    const p = printUrlInHiddenFrame("/factura/no-existe", { env });
    frames[0].hasMarker = false;
    frames[0].fire("load");
    expect(await reasonOf(p)).toBe("load_failed");
    expect(frames[0].removed).toBe(true);
    expect(frames[0].fakeWin.printed).toBe(0);
  });

  it("rechaza load_failed si el documento quedó inaccesible o el iframe disparó error", async () => {
    const a = makeEnv();
    const pa = printUrlInHiddenFrame("/factura/abc", { env: a.env });
    a.frames[0].detached = true;
    a.frames[0].fire("load");
    expect(await reasonOf(pa)).toBe("load_failed");
    expect(a.frames[0].removed).toBe(true);

    const b = makeEnv();
    const pb = printUrlInHiddenFrame("/factura/abc", { env: b.env });
    b.frames[0].fire("error");
    expect(await reasonOf(pb)).toBe("load_failed");
    expect(b.frames[0].removed).toBe(true);
  });

  it("rechaza timeout si el documento nunca termina de cargar", async () => {
    const { env, frames, fireTimer } = makeEnv();
    const p = printUrlInHiddenFrame("/factura/abc", { env });
    fireTimer(30_000);
    expect(await reasonOf(p)).toBe("timeout");
    expect(frames[0].removed).toBe(true);
  });

  it("rechaza blocked si el navegador tira al llamar print(), y limpia", async () => {
    const { env, frames, timers } = makeEnv();
    const p = printUrlInHiddenFrame("/factura/abc", { env });
    frames[0].fakeWin.throwOnPrint = true;
    frames[0].fire("load");
    expect(await reasonOf(p)).toBe("blocked");
    expect(frames[0].removed).toBe(true);
    expect(timers.size).toBe(0);
  });

  it("rechaza cross_origin sin crear iframe si la URL es de otro origen", async () => {
    const { env, frames } = makeEnv();
    expect(
      await reasonOf(
        printUrlInHiddenFrame("https://otro.sitio.test/factura/1", { env }),
      ),
    ).toBe("cross_origin");
    expect(
      await reasonOf(
        printUrlInHiddenFrame("http://demo.mesapay.test/factura/1", { env }),
      ),
    ).toBe("cross_origin");
    expect(frames).toHaveLength(0);
  });

  it("un solo iframe a la vez: una llamada nueva retira el anterior y rechaza su promesa si seguía cargando", async () => {
    const { env, frames, fireTimer } = makeEnv();
    const first = printUrlInHiddenFrame("/factura/1", { env });
    const second = printUrlInHiddenFrame("/factura/2", { env });
    expect(await reasonOf(first)).toBe("superseded");
    expect(frames[0].removed).toBe(true);
    expect(frames[1].removed).toBe(false);

    frames[1].fire("load");
    await expect(second).resolves.toBeUndefined();
    expect(frames[1].fakeWin.printed).toBe(1);

    // Tampoco quedan dos si el anterior ya imprimió pero afterprint no llegó.
    const third = printUrlInHiddenFrame("/factura/3", { env });
    expect(frames[1].removed).toBe(true);
    frames[2].fire("load");
    await third;
    fireTimer(60_000);
    expect(frames[2].removed).toBe(true);
  });

  it("cancelHiddenFramePrint retira el iframe pendiente y rechaza con cancelled", async () => {
    const { env, frames } = makeEnv();
    const p = printUrlInHiddenFrame("/factura/1", { env });
    cancelHiddenFramePrint();
    expect(await reasonOf(p)).toBe("cancelled");
    expect(frames[0].removed).toBe(true);
  });
});

describe("printInBrowserOrOpenTab", () => {
  it("printed cuando el iframe imprime; la pestaña ni se toca", async () => {
    const { env, frames } = makeEnv();
    const opened: string[] = [];
    const p = printInBrowserOrOpenTab("/factura/1", {
      env,
      tabUrl: "/factura/1?print=1",
      openTab: (u) => {
        opened.push(u);
        return true;
      },
    });
    frames[0].fire("load");
    expect(await p).toEqual({ kind: "printed" });
    expect(opened).toEqual([]);
  });

  it("si el navegador bloquea print(), abre la pestaña de respaldo y dice si también la bloqueó", async () => {
    const a = makeEnv();
    const opened: string[] = [];
    const pa = printInBrowserOrOpenTab("/factura/1", {
      env: a.env,
      tabUrl: "/factura/1?print=1",
      openTab: (u) => {
        opened.push(u);
        return true;
      },
    });
    a.frames[0].fakeWin.throwOnPrint = true;
    a.frames[0].fire("load");
    expect(await pa).toEqual({ kind: "tab", blocked: false });
    expect(opened).toEqual(["/factura/1?print=1"]);

    const b = makeEnv();
    const pb = printInBrowserOrOpenTab("/factura/1", {
      env: b.env,
      openTab: () => false,
    });
    b.frames[0].fakeWin.throwOnPrint = true;
    b.frames[0].fire("load");
    expect(await pb).toEqual({ kind: "tab", blocked: true });
  });

  it("si el documento no cargó, no abre pestaña: failed con el motivo", async () => {
    const { env, frames } = makeEnv();
    let openedTab = false;
    const p = printInBrowserOrOpenTab("/factura/1", {
      env,
      openTab: () => {
        openedTab = true;
        return true;
      },
    });
    frames[0].hasMarker = false;
    frames[0].fire("load");
    expect(await p).toEqual({ kind: "failed", reason: "load_failed" });
    expect(openedTab).toBe(false);
  });
});

describe("isEmbeddedFrame", () => {
  it("es false en la pestaña propia y true dentro de un iframe", () => {
    const top = {};
    expect(isEmbeddedFrame({ self: top, top })).toBe(false);
    expect(isEmbeddedFrame({ self: {}, top })).toBe(true);
  });

  it("si no se puede mirar `top`, asume embebido", () => {
    const win = {
      self: {},
      get top(): unknown {
        throw new Error("cross-origin");
      },
    };
    expect(isEmbeddedFrame(win)).toBe(true);
  });
});
