import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEVICE_PAPER_MM,
  defaultPrintDestination,
  devicePaperFromParam,
  devicePrintHelpHref,
  devicePrintHref,
  otherDestination,
  parseStoredPrintPreference,
  printPreferenceStorageKey,
  readPrintPreference,
  resolvePrintPreference,
  withQueryParam,
  writePrintPreference,
} from "./printDestination";

/**
 * «Imprimir en: Impresora de caja · Este dispositivo», recordado POR
 * DISPOSITIVO y por comercio. Lo que se blinda:
 *
 *   · el valor de la primera vez depende del rol (datáfono → el equipo);
 *   · leer y guardar no rompe nunca, aunque el almacenamiento no exista,
 *     tire o tenga basura;
 *   · la vista imprimible recibe el papel del equipo por `?w=`.
 */

/** Un localStorage de mentira que se puede romper a pedido. */
function fakeStorage(opts: { throwOnGet?: boolean; throwOnSet?: boolean } = {}) {
  const data = new Map<string, string>();
  return {
    data,
    getItem(key: string) {
      if (opts.throwOnGet) throw new Error("SecurityError");
      return data.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (opts.throwOnSet) throw new Error("QuotaExceededError");
      data.set(key, value);
    },
  };
}

describe("el valor por defecto (la primera vez en el equipo)", () => {
  it("el usuario Datáfono imprime en el equipo: es el Smart POS con impresora integrada", () => {
    expect(defaultPrintDestination("terminal")).toBe("device");
  });

  it("los demás, en la caja (sin impresora de caja, el respaldo ya imprime acá)", () => {
    for (const role of ["operator", "mesero", "platform_admin", "group_admin", null, undefined]) {
      expect(defaultPrintDestination(role)).toBe("caja");
    }
  });

  it("el papel del equipo arranca en 58 mm", () => {
    expect(DEFAULT_DEVICE_PAPER_MM).toBe(58);
    expect(resolvePrintPreference(null, "mesero")).toEqual({
      destination: "caja",
      paperMm: 58,
      remembered: false,
    });
  });
});

describe("recordado por equipo y por comercio", () => {
  it("una clave por comercio; sin comercio en la sesión, una general", () => {
    expect(printPreferenceStorageKey("rest-1")).toBe("mesapay.imprimir.rest-1");
    expect(printPreferenceStorageKey("rest-2")).not.toBe(printPreferenceStorageKey("rest-1"));
    expect(printPreferenceStorageKey(null)).toBe("mesapay.imprimir.general");
    expect(printPreferenceStorageKey("  ")).toBe("mesapay.imprimir.general");
  });

  it("guarda y vuelve a leer la última elección", () => {
    const storage = fakeStorage();
    const key = printPreferenceStorageKey("rest-1");
    expect(writePrintPreference(storage, key, { destination: "device", paperMm: 80 })).toBe(true);
    const stored = readPrintPreference(storage, key);
    expect(stored).toEqual({ destination: "device", paperMm: 80 });
    // Lo recordado gana sobre el valor por defecto del rol.
    expect(resolvePrintPreference(stored, "operator")).toEqual({
      destination: "device",
      paperMm: 80,
      remembered: true,
    });
    expect(
      resolvePrintPreference(parseStoredPrintPreference('{"destination":"caja"}'), "terminal"),
    ).toMatchObject({ destination: "caja", remembered: true });
  });

  it("sin almacenamiento, o si tira al leer, no hay recuerdo (y no rompe)", () => {
    const key = printPreferenceStorageKey("rest-1");
    expect(readPrintPreference(null, key)).toBeNull();
    expect(readPrintPreference(undefined, key)).toBeNull();
    expect(readPrintPreference(fakeStorage({ throwOnGet: true }), key)).toBeNull();
    expect(resolvePrintPreference(null, "terminal")).toMatchObject({
      destination: "device",
      remembered: false,
    });
  });

  it("si tira al guardar, devuelve false y no rompe (se imprime igual)", () => {
    const key = printPreferenceStorageKey("rest-1");
    expect(writePrintPreference(fakeStorage({ throwOnSet: true }), key, { destination: "caja", paperMm: 58 })).toBe(false);
    expect(writePrintPreference(null, key, { destination: "caja", paperMm: 58 })).toBe(false);
  });

  it("basura guardada (JSON roto, otra versión, valores raros) se ignora", () => {
    for (const raw of ["", "no-json", "null", "42", '"device"', "[]", '{"destination":"impresora"}', '{"paperMm":57}']) {
      expect(parseStoredPrintPreference(raw)).toBeNull();
    }
    // Lo que sirve se rescata y lo demás vuelve al valor por defecto.
    expect(parseStoredPrintPreference('{"destination":"device","paperMm":"80"}')).toEqual({
      destination: "device",
    });
    expect(resolvePrintPreference({ paperMm: 80 }, "terminal")).toEqual({
      destination: "device",
      paperMm: 80,
      remembered: false,
    });
  });
});

describe("la vista imprimible al papel del equipo", () => {
  it("agrega ?w= sin tocar el resto de la consulta ni el ancla", () => {
    expect(devicePrintHref("/factura/inv-1", 58)).toBe("/factura/inv-1?w=58");
    expect(devicePrintHref("/factura/inv-1?print=1", 80)).toBe("/factura/inv-1?print=1&w=80");
    expect(devicePrintHref("/factura/inv-1?w=80", 58)).toBe("/factura/inv-1?w=58");
    expect(withQueryParam("/a?x=1#y", "print", "1")).toBe("/a?x=1&print=1#y");
  });

  it("la página sólo acepta 58 u 80; cualquier otra cosa es el papel del comercio", () => {
    expect(devicePaperFromParam("58")).toBe(58);
    expect(devicePaperFromParam("80")).toBe(80);
    expect(devicePaperFromParam(["58", "80"])).toBe(58);
    for (const raw of [undefined, null, "", "57", "120", "58mm", "abc"]) {
      expect(devicePaperFromParam(raw)).toBeNull();
    }
  });
});

describe("«Reintentar en…» y la guía", () => {
  it("el otro destino", () => {
    expect(otherDestination("caja")).toBe("device");
    expect(otherDestination("device")).toBe("caja");
  });

  it("la guía va a la ayuda de quien mira; el datáfono no tiene ayuda (se le dice el paso en el aviso)", () => {
    expect(devicePrintHelpHref("operator")).toBe(
      "/operator/ayuda/impresion-y-equipos/imprimir-en-este-dispositivo",
    );
    expect(devicePrintHelpHref("mesero")).toBe(
      "/mesero/ayuda/impresion-y-equipos/imprimir-en-este-dispositivo",
    );
    expect(devicePrintHelpHref("terminal")).toBeNull();
    expect(devicePrintHelpHref(null)).toBeNull();
  });
});
