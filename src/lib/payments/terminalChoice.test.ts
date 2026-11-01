// A qué datáfono va el cobro: con uno, ése; con varios, el último elegido en
// este aparato o ninguno hasta elegir. Nunca "el primero de la lista".
import { describe, expect, it } from "vitest";
import {
  needsTerminalPicker,
  readRememberedTerminal,
  rememberTerminal,
  resolveTerminalChoice,
  terminalChoiceStorageKey,
} from "./terminalChoice";

const CAJA = { id: "kd-caja", label: "Caja" };
const TERRAZA = { id: "kd-terraza", label: "Terraza" };
const BARRA = { id: "kd-barra", label: "Barra" };

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
}

describe("resolveTerminalChoice", () => {
  it("con un solo datáfono disponible, el cobro va directo a ése (aunque se recuerde otro)", () => {
    expect(resolveTerminalChoice([CAJA], null)).toBe(CAJA);
    expect(resolveTerminalChoice([CAJA], "kd-viejo")).toBe(CAJA);
    expect(needsTerminalPicker([CAJA])).toBe(false);
  });

  it("con dos o más, el recordado en este aparato queda preseleccionado", () => {
    expect(resolveTerminalChoice([CAJA, TERRAZA, BARRA], "kd-terraza")).toBe(TERRAZA);
    expect(needsTerminalPicker([CAJA, TERRAZA])).toBe(true);
  });

  it("con dos o más y nada recordado, NO se adivina: hay que elegir (antes iba al primero)", () => {
    expect(resolveTerminalChoice([CAJA, TERRAZA], null)).toBeNull();
    expect(resolveTerminalChoice([CAJA, TERRAZA], "")).toBeNull();
  });

  it("si el recordado ya no está disponible (inactivo, sin serial, borrado), hay que elegir de nuevo", () => {
    expect(resolveTerminalChoice([CAJA, TERRAZA], "kd-barra")).toBeNull();
  });

  it("sin datáfonos no hay destino", () => {
    expect(resolveTerminalChoice([], "kd-caja")).toBeNull();
    expect(needsTerminalPicker([])).toBe(false);
  });
});

describe("recordar el último elegido (localStorage, por comercio)", () => {
  it("guarda y lee por comercio", () => {
    const storage = memoryStorage();
    const key = terminalChoiceStorageKey("sonymelona");
    expect(key).toBe("mesapay.datafono.sonymelona");
    expect(readRememberedTerminal(storage, key)).toBeNull();
    rememberTerminal(storage, key, "kd-terraza");
    expect(readRememberedTerminal(storage, key)).toBe("kd-terraza");
    expect(readRememberedTerminal(storage, terminalChoiceStorageKey("otro"))).toBeNull();
  });

  it("si el almacenamiento falla (modo privado, bloqueado) o no existe, no rompe: sólo no recuerda", () => {
    const broken = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(readRememberedTerminal(broken, "k")).toBeNull();
    expect(() => rememberTerminal(broken, "k", "kd-caja")).not.toThrow();
    expect(readRememberedTerminal(null, "k")).toBeNull();
    expect(() => rememberTerminal(undefined, "k", "kd-caja")).not.toThrow();
  });
});
