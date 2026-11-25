import { afterEach, describe, expect, it, vi } from "vitest";

import {
  activeSectionKey,
  parseCollapsed,
  readCollapsed,
  resolveCollapsed,
  subscribeToActiveSection,
  writeCollapsed,
} from "./activeSectionMemory";

/**
 * El plegado de «Activas» se recuerda por aparato y comercio. La fuente de
 * verdad es lo persistido; el respaldo en memoria es sólo para cuando el
 * almacenamiento falla, y vale únicamente para SU clave.
 */

/** `localStorage` de mentira, con interruptor para simular que no está. */
function fakeStorage(initial: Record<string, string> = {}) {
  let broken = false;
  const data = new Map(Object.entries(initial));
  return {
    break: () => {
      broken = true;
    },
    data,
    getItem(k: string) {
      if (broken) throw new Error("sin almacenamiento");
      return data.get(k) ?? null;
    },
    setItem(k: string, v: string) {
      if (broken) throw new Error("sin almacenamiento");
      data.set(k, v);
    },
    removeItem(k: string) {
      if (broken) throw new Error("sin almacenamiento");
      data.delete(k);
    },
  };
}

/** `window` de mentira: almacenamiento + registro de oyentes. */
function fakeWindow(storage: ReturnType<typeof fakeStorage>) {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  return {
    localStorage: storage,
    listeners,
    addEventListener(type: string, fn: (e: unknown) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: (e: unknown) => void) {
      listeners.get(type)?.delete(fn);
    },
    emit(type: string, event?: unknown) {
      for (const fn of listeners.get(type) ?? []) fn(event);
    },
  };
}

function install(initial: Record<string, string> = {}) {
  const storage = fakeStorage(initial);
  const win = fakeWindow(storage);
  vi.stubGlobal("window", win);
  return { storage, win };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const TERESITA = activeSectionKey("casa-teresita");
const OTRO = activeSectionKey("otro-local");

describe("activeSectionKey", () => {
  it("una clave por comercio: dos restaurantes no se pisan", () => {
    expect(TERESITA).toBe("mesapay.activeSection.casa-teresita");
    expect(TERESITA).not.toBe(OTRO);
  });

  it("sin comercio, una clave aparte y no una a medias", () => {
    expect(activeSectionKey("")).toBe("mesapay.activeSection.anon");
  });
});

describe("parseCollapsed", () => {
  it("sólo lo guardado por nosotros pliega", () => {
    expect(parseCollapsed("collapsed")).toBe(true);
  });

  it("por defecto, desplegada: nada guardado o un valor viejo/raro", () => {
    expect(parseCollapsed(null)).toBe(false);
    expect(parseCollapsed("")).toBe(false);
    expect(parseCollapsed("true")).toBe(false);
  });
});

describe("readCollapsed / writeCollapsed", () => {
  it("guarda el plegado y lo vuelve a leer", () => {
    install();
    expect(writeCollapsed(TERESITA, true)).toBe(true);
    expect(readCollapsed(TERESITA)).toBe(true);
  });

  it("desplegar borra la clave en vez de guardar «expanded»", () => {
    const { storage } = install({ [TERESITA]: "collapsed" });
    expect(writeCollapsed(TERESITA, false)).toBe(true);
    expect(storage.data.has(TERESITA)).toBe(false);
    expect(readCollapsed(TERESITA)).toBe(false);
  });

  it("cada comercio por su lado", () => {
    install();
    writeCollapsed(TERESITA, true);
    expect(readCollapsed(TERESITA)).toBe(true);
    expect(readCollapsed(OTRO)).toBe(false);
  });

  it("sin almacenamiento: no revienta, avisa que no pudo y lee desplegada", () => {
    const { storage } = install();
    storage.break();
    expect(writeCollapsed(TERESITA, true)).toBe(false);
    expect(readCollapsed(TERESITA)).toBe(false);
  });
});

describe("resolveCollapsed", () => {
  it("sin respaldo manda lo persistido", () => {
    expect(resolveCollapsed(true, null, TERESITA)).toBe(true);
    expect(resolveCollapsed(false, null, TERESITA)).toBe(false);
  });

  it("el respaldo de OTRA clave no se hereda al cambiar de comercio", () => {
    // El bug: plegar en Casa Teresita y que el comercio nuevo —sin nada
    // guardado— apareciera plegado.
    expect(resolveCollapsed(false, { key: TERESITA, collapsed: true }, OTRO)).toBe(false);
  });

  it("el respaldo de SU clave manda (ahí no hay nada persistido que leer)", () => {
    expect(resolveCollapsed(false, { key: TERESITA, collapsed: true }, TERESITA)).toBe(true);
  });

  it("lo que cambió otra pestaña no queda tapado por una copia en memoria", () => {
    // Con almacenamiento sano no hay respaldo, así que el valor nuevo
    // que llega por el evento `storage` se ve tal cual.
    expect(resolveCollapsed(true, null, TERESITA)).toBe(true);
  });
});

describe("subscribeToActiveSection", () => {
  it("avisa cuando otra pestaña toca ESTA clave", () => {
    const { win } = install();
    const onChange = vi.fn();
    subscribeToActiveSection(TERESITA, onChange);
    win.emit("storage", { key: TERESITA });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("no avisa por la clave de otro comercio", () => {
    const { win } = install();
    const onChange = vi.fn();
    subscribeToActiveSection(TERESITA, onChange);
    win.emit("storage", { key: OTRO });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("un borrado completo del almacenamiento (key null) también avisa", () => {
    const { win } = install();
    const onChange = vi.fn();
    subscribeToActiveSection(TERESITA, onChange);
    win.emit("storage", { key: null });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("el evento propio cubre la pestaña actual, donde «storage» no dispara", () => {
    const { win } = install();
    const onChange = vi.fn();
    subscribeToActiveSection(TERESITA, onChange);
    win.emit("mesapay:active-section");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("al desuscribir deja de avisar", () => {
    const { win } = install();
    const onChange = vi.fn();
    subscribeToActiveSection(TERESITA, onChange)();
    win.emit("storage", { key: TERESITA });
    win.emit("mesapay:active-section");
    expect(onChange).not.toHaveBeenCalled();
  });
});

/**
 * Las dos secuencias que reprodujo la revisión, armadas con las piezas
 * reales del hook (lo que React hace es llamarlas en este orden).
 */
describe("secuencias entre pestañas y comercios", () => {
  it("pestaña A desplegada, pestaña B pliega → A se entera", () => {
    const { win } = install();
    let stored = readCollapsed(TERESITA);
    const fallback = null; // el almacenamiento funciona: no hay respaldo
    subscribeToActiveSection(TERESITA, () => {
      stored = readCollapsed(TERESITA);
    });
    expect(resolveCollapsed(stored, fallback, TERESITA)).toBe(false);

    // La pestaña B pliega y el navegador avisa a la A.
    writeCollapsed(TERESITA, true);
    win.emit("storage", { key: TERESITA });
    expect(resolveCollapsed(stored, fallback, TERESITA)).toBe(true);
  });

  it("plegar en un comercio y cambiar al otro sin remontar no lo hereda", () => {
    install();
    writeCollapsed(TERESITA, true);
    expect(resolveCollapsed(readCollapsed(TERESITA), null, TERESITA)).toBe(true);
    expect(resolveCollapsed(readCollapsed(OTRO), null, OTRO)).toBe(false);
  });
});
