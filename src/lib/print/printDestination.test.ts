import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEVICE_PAPER_MM,
  DEVICE_PAPER_PRESETS,
  TERMINAL_DEVICE_PAPER_MM,
  defaultDevicePaperMm,
  defaultPrintDestination,
  devicePaperFromParam,
  devicePrintHelpHref,
  devicePrintHref,
  otherDestination,
  parseDevicePaperMm,
  parseStoredPrintPreference,
  printDestinationsFor,
  printPreferenceStorageKey,
  receiptSidePaddingMm,
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

  it("el papel arranca en 55 mm para el datáfono (Sunmi P3 de Kushki) y en 58 para los demás", () => {
    expect(TERMINAL_DEVICE_PAPER_MM).toBe(55);
    expect(DEFAULT_DEVICE_PAPER_MM).toBe(58);
    expect(defaultDevicePaperMm("terminal")).toBe(55);
    for (const role of ["operator", "mesero", "platform_admin", null]) {
      expect(defaultDevicePaperMm(role)).toBe(58);
    }
    expect(resolvePrintPreference(null, "terminal")).toEqual({
      destination: "device",
      paperMm: 55,
      remembered: false,
    });
    expect(resolvePrintPreference(null, "mesero")).toEqual({
      destination: "caja",
      paperMm: 58,
      remembered: false,
    });
  });

  it("los atajos del selector son 55, 58 y 80", () => {
    expect(DEVICE_PAPER_PRESETS).toEqual([55, 58, 80]);
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
    for (const raw of [
      "",
      "no-json",
      "null",
      "42",
      '"device"',
      "[]",
      '{"destination":"impresora"}',
      '{"paperMm":39}',
      '{"paperMm":121}',
      '{"paperMm":57.5}',
    ]) {
      expect(parseStoredPrintPreference(raw)).toBeNull();
    }
    // Un ancho fuera de los atajos, pero del rango, vale (se escribió en «Otro»).
    expect(parseStoredPrintPreference('{"destination":"device","paperMm":52}')).toEqual({
      destination: "device",
      paperMm: 52,
    });
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

  it("la página acepta cualquier ancho entero de 40 a 120 mm; lo demás es el papel del comercio", () => {
    expect(devicePaperFromParam("55")).toBe(55);
    expect(devicePaperFromParam("58")).toBe(58);
    expect(devicePaperFromParam("80")).toBe(80);
    expect(devicePaperFromParam("40")).toBe(40);
    expect(devicePaperFromParam("120")).toBe(120);
    expect(devicePaperFromParam(["55", "80"])).toBe(55);
    for (const raw of [undefined, null, "", "39", "121", "999", "55mm", "5e1", "55.5", " 55", "abc"]) {
      expect(devicePaperFromParam(raw)).toBeNull();
    }
  });

  it("«Otro»: lo que se escribe se lleva a mm enteros del rango, o no se guarda", () => {
    expect(parseDevicePaperMm("55")).toBe(55);
    expect(parseDevicePaperMm(" 52 ")).toBe(52);
    expect(parseDevicePaperMm("57,5")).toBe(58);
    expect(parseDevicePaperMm(56.4)).toBe(56);
    for (const raw of ["", "abc", "39", "121", "-55", "55mm", null, undefined, Number.NaN]) {
      expect(parseDevicePaperMm(raw)).toBeNull();
    }
  });

  it("el relleno lateral deja el texto en ~48 mm (cabezal de 384 puntos): 58 y 80 como siempre", () => {
    expect(receiptSidePaddingMm(80)).toBe(4);
    expect(receiptSidePaddingMm(58)).toBe(5);
    expect(receiptSidePaddingMm(55)).toBe(3.5);
    expect(receiptSidePaddingMm(52)).toBe(2);
    expect(receiptSidePaddingMm(45)).toBe(2);
    expect(receiptSidePaddingMm(70)).toBe(5);
    expect(55 - 2 * receiptSidePaddingMm(55)).toBe(48);
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

describe("«Impresora de caja · Datáfono · Este dispositivo»", () => {
  it("«Datáfono» para el personal sólo con datáfonos Kushki; el usuario Datáfono conserva su «Este dispositivo»", () => {
    expect(printDestinationsFor("operator", true)).toEqual(["caja", "terminal", "device"]);
    expect(printDestinationsFor("mesero", true)).toEqual(["caja", "terminal", "device"]);
    expect(printDestinationsFor("mesero", false)).toEqual(["caja", "device"]);
    expect(printDestinationsFor("terminal", true)).toEqual(["caja", "device"]);
  });

  it("«Datáfono» se recuerda como los demás destinos", () => {
    expect(parseStoredPrintPreference('{"destination":"terminal","paperMm":58}')).toEqual({
      destination: "terminal",
      paperMm: 58,
    });
    expect(resolvePrintPreference({ destination: "terminal" }, "mesero", true)).toMatchObject({
      destination: "terminal",
      remembered: true,
    });
  });

  it("sin datáfonos, un «Datáfono» guardado vuelve a la caja; mientras no se sabe, se respeta", () => {
    expect(resolvePrintPreference({ destination: "terminal" }, "mesero", false)).toMatchObject({ destination: "caja" });
    expect(resolvePrintPreference({ destination: "terminal" }, "mesero")).toMatchObject({ destination: "terminal" });
  });

  it("para el usuario Datáfono, «Datáfono» es su «Este dispositivo»", () => {
    expect(resolvePrintPreference({ destination: "terminal" }, "terminal", true)).toMatchObject({
      destination: "device",
    });
  });

  it("si «Datáfono» falla, se ofrece la caja", () => {
    expect(otherDestination("terminal")).toBe("caja");
  });
});

