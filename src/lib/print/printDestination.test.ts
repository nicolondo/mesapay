import { describe, expect, it } from "vitest";
import {
  DEVICE_PAPER_MM,
  defaultPrintDestination,
  devicePaperFromParam,
  devicePrintHelpHref,
  devicePrintHref,
  otherDestination,
  parseStoredPrintPreference,
  printDestinationsFor,
  printPreferenceStorageKey,
  receiptSidePaddingMm,
  readPrintPreference,
  resolvePrintPreference,
  staleStoredPrintPreference,
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
  it("el usuario Datáfono imprime en su datáfono (Kushki); sin datáfonos, en la caja", () => {
    expect(defaultPrintDestination("terminal")).toBe("terminal");
    expect(defaultPrintDestination("terminal", false)).toBe("caja");
  });

  it("los demás, en la caja (sin impresora de caja, el respaldo ya imprime acá)", () => {
    for (const role of ["operator", "mesero", "platform_admin", "group_admin", null, undefined]) {
      expect(defaultPrintDestination(role)).toBe("caja");
    }
  });

  it("el papel de «Este dispositivo» no se elige: 55 mm para todos", () => {
    expect(DEVICE_PAPER_MM).toBe(55);
    expect(resolvePrintPreference(null, "terminal")).toEqual({ destination: "terminal", remembered: false });
    expect(resolvePrintPreference(null, "mesero")).toEqual({ destination: "caja", remembered: false });
  });
});

describe("«Impresora de caja · Datáfono · Este dispositivo»", () => {
  it("«Datáfono» sólo con datáfonos Kushki; el usuario Datáfono no ve «Este dispositivo» (es lo mismo)", () => {
    expect(printDestinationsFor("operator", true)).toEqual(["caja", "terminal", "device"]);
    expect(printDestinationsFor("mesero", false)).toEqual(["caja", "device"]);
    expect(printDestinationsFor("terminal", true)).toEqual(["caja", "terminal"]);
    expect(printDestinationsFor("terminal", false)).toEqual(["caja"]);
  });

  it("para el usuario Datáfono, un «Este dispositivo» guardado es su «Datáfono»", () => {
    expect(resolvePrintPreference({ destination: "device" }, "terminal", true)).toEqual({
      destination: "terminal",
      remembered: true,
    });
    expect(resolvePrintPreference({ destination: "device" }, "mesero", true)).toMatchObject({ destination: "device" });
  });

  it("sin datáfonos, un «Datáfono» guardado vuelve a la caja; mientras no se sabe, se respeta", () => {
    expect(resolvePrintPreference({ destination: "terminal" }, "mesero", false)).toMatchObject({ destination: "caja" });
    expect(resolvePrintPreference({ destination: "terminal" }, "mesero", undefined)).toMatchObject({
      destination: "terminal",
    });
    expect(parseStoredPrintPreference('{"destination":"terminal"}')).toEqual({ destination: "terminal" });
  });

  it("si falla, se ofrece el otro: la caja, o desde la caja, el equipo (el datáfono para su usuario)", () => {
    expect(otherDestination("terminal")).toBe("caja");
    expect(otherDestination("device")).toBe("caja");
    expect(otherDestination("caja")).toBe("device");
    expect(otherDestination("caja", "terminal")).toBe("terminal");
  });
});

describe("recordado por equipo y por comercio", () => {
  it("una clave por comercio; sin comercio en la sesión, una general", () => {
    expect(printPreferenceStorageKey("rest-1")).toBe("mesapay.imprimir.rest-1");
    expect(printPreferenceStorageKey("rest-2")).not.toBe(printPreferenceStorageKey("rest-1"));
    expect(printPreferenceStorageKey(null)).toBe("mesapay.imprimir.general");
    expect(printPreferenceStorageKey("  ")).toBe("mesapay.imprimir.general");
  });

  it("guarda y vuelve a leer la última elección (sólo el destino)", () => {
    const storage = fakeStorage();
    const key = printPreferenceStorageKey("rest-1");
    expect(writePrintPreference(storage, key, { destination: "device" })).toBe(true);
    expect(storage.data.get(key)).toBe('{"destination":"device"}');
    const stored = readPrintPreference(storage, key);
    expect(stored).toEqual({ destination: "device" });
    // Lo recordado gana sobre el valor por defecto del rol.
    expect(resolvePrintPreference(stored, "operator")).toEqual({ destination: "device", remembered: true });
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
      destination: "terminal",
      remembered: false,
    });
  });

  it("si tira al guardar, devuelve false y no rompe (se imprime igual)", () => {
    const key = printPreferenceStorageKey("rest-1");
    expect(writePrintPreference(fakeStorage({ throwOnSet: true }), key, { destination: "caja" })).toBe(false);
    expect(writePrintPreference(null, key, { destination: "caja" })).toBe(false);
  });

  it("basura guardada (JSON roto, otra versión, valores raros) se ignora", () => {
    for (const raw of ["", "no-json", "null", "42", '"device"', "[]", '{"destination":"impresora"}', '{"paperMm":58}']) {
      expect(parseStoredPrintPreference(raw)).toBeNull();
    }
    // El ancho que guardaba la versión con selector se ignora; el destino vale.
    expect(parseStoredPrintPreference('{"destination":"device","paperMm":52}')).toEqual({ destination: "device" });
  });

  it("lo guardado de la versión con selector de papel se limpia (el destino se conserva)", () => {
    expect(staleStoredPrintPreference('{"destination":"device","paperMm":58}')).toBe('{"destination":"device"}');
    expect(staleStoredPrintPreference('{"paperMm":80}')).toBeNull();
    expect(staleStoredPrintPreference("no-json")).toBeNull();
    // Limpio (o nada guardado): no se toca.
    expect(staleStoredPrintPreference('{"destination":"caja"}')).toBeUndefined();
    expect(staleStoredPrintPreference(null)).toBeUndefined();
    expect(staleStoredPrintPreference("")).toBeUndefined();
  });
});

describe("la vista imprimible al papel del equipo", () => {
  it("agrega ?w= sin tocar el resto de la consulta ni el ancla", () => {
    expect(devicePrintHref("/factura/inv-1")).toBe("/factura/inv-1?w=55");
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
