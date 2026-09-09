import { describe, it, expect } from "vitest";
import {
  duplicateLocalKeys,
  invalidSubStations,
  isValidPrinterHost,
  printersReportSchema,
} from "./printerConfig";

describe("isValidPrinterHost", () => {
  it("acepta IPv4 de red local", () => {
    for (const host of ["192.168.1.50", "10.0.0.7", "172.16.254.1", "0.0.0.0"]) {
      expect(isValidPrinterHost(host)).toBe(true);
    }
  });

  it("acepta hostname (hay locales que le ponen nombre DNS a la térmica)", () => {
    for (const host of ["impresora-cocina", "tm-t20.local", "printer1.lan"]) {
      expect(isValidPrinterHost(host)).toBe(true);
    }
  });

  it("rechaza el error clásico: pegar host:puerto o una URL en el campo", () => {
    expect(isValidPrinterHost("192.168.1.50:9100")).toBe(false);
    expect(isValidPrinterHost("http://192.168.1.50")).toBe(false);
    expect(isValidPrinterHost("192.168.1.50/print")).toBe(false);
    expect(isValidPrinterHost("192.168.1 50")).toBe(false);
  });

  it("rechaza IPs imposibles en vez de tratarlas como hostname", () => {
    expect(isValidPrinterHost("192.168.1.300")).toBe(false);
    expect(isValidPrinterHost("192.168.1")).toBe(false);
    expect(isValidPrinterHost("1.2.3.4.5")).toBe(false);
  });

  it("rechaza octetos con cero a la izquierda (se leen como octal)", () => {
    expect(isValidPrinterHost("192.168.01.50")).toBe(false);
  });

  it("rechaza vacío y etiquetas mal formadas", () => {
    expect(isValidPrinterHost("")).toBe(false);
    expect(isValidPrinterHost("-cocina")).toBe(false);
    expect(isValidPrinterHost("cocina-")).toBe(false);
    expect(isValidPrinterHost("coci na")).toBe(false);
  });
});

describe("printersReportSchema", () => {
  const ok = {
    localKey: "cocina",
    label: "Cocina",
    host: "192.168.1.50",
    port: 9100,
    station: "kitchen",
    barSubStation: null,
    paperWidthMm: 80,
    active: true,
  };

  it("acepta el body del contrato", () => {
    const parsed = printersReportSchema.safeParse({ printers: [ok] });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.printers[0].host).toBe("192.168.1.50");
  });

  it("el puerto por defecto es 9100 (RAW/JetDirect)", () => {
    const parsed = printersReportSchema.safeParse({
      printers: [{ ...ok, port: undefined }],
    });
    expect(parsed.success && parsed.data.printers[0].port).toBe(9100);
  });

  it("una lista vacía es válida: es cómo se apaga todo el set", () => {
    const parsed = printersReportSchema.safeParse({ printers: [] });
    expect(parsed.success).toBe(true);
  });

  it("rechaza puertos fuera de rango", () => {
    for (const port of [0, 65536, -1, 1.5]) {
      expect(
        printersReportSchema.safeParse({ printers: [{ ...ok, port }] }).success,
      ).toBe(false);
    }
  });

  it("rechaza una estación que no está en el enum PrepStation", () => {
    expect(
      printersReportSchema.safeParse({
        printers: [{ ...ok, station: "postres" }],
      }).success,
    ).toBe(false);
  });

  it("rechaza host inválido", () => {
    expect(
      printersReportSchema.safeParse({
        printers: [{ ...ok, host: "192.168.1.50:9100" }],
      }).success,
    ).toBe(false);
  });

  it("rechaza localKey con espacios o vacío", () => {
    expect(
      printersReportSchema.safeParse({
        printers: [{ ...ok, localKey: "la cocina" }],
      }).success,
    ).toBe(false);
    expect(
      printersReportSchema.safeParse({ printers: [{ ...ok, localKey: "" }] })
        .success,
    ).toBe(false);
  });

  it("acepta paperWidthMm y barSubStation ausentes (heredan del comercio)", () => {
    const parsed = printersReportSchema.safeParse({
      printers: [
        {
          localKey: "barra",
          label: "Barra",
          host: "printer.lan",
          station: "bar",
        },
      ],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.printers[0].active).toBe(true);
  });

  it("corta un set absurdamente grande", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      ...ok,
      localKey: `p${i}`,
    }));
    expect(printersReportSchema.safeParse({ printers: many }).success).toBe(
      false,
    );
  });
});

describe("duplicateLocalKeys", () => {
  it("detecta el copiar-pegar mal hecho en la config del agente", () => {
    expect(
      duplicateLocalKeys([
        { localKey: "cocina" },
        { localKey: "barra" },
        { localKey: "cocina" },
      ]),
    ).toEqual(["cocina"]);
  });

  it("un set sano no tiene duplicados", () => {
    expect(
      duplicateLocalKeys([{ localKey: "cocina" }, { localKey: "barra" }]),
    ).toEqual([]);
  });
});

describe("invalidSubStations", () => {
  it("acepta una sub-estación que el comercio definió", () => {
    expect(
      invalidSubStations(
        [{ station: "bar", barSubStation: "cócteles" }],
        ["cócteles", "cerveza"],
      ),
    ).toEqual([]);
  });

  it("rechaza una sub-estación inexistente: no recibiría NUNCA un trabajo", () => {
    expect(
      invalidSubStations(
        [{ station: "bar", barSubStation: "jugos" }],
        ["cócteles"],
      ),
    ).toEqual(["jugos"]);
  });

  it("rechaza sub-estación en una impresora que no es de barra", () => {
    expect(
      invalidSubStations(
        [{ station: "kitchen", barSubStation: "cócteles" }],
        ["cócteles"],
      ),
    ).toEqual(["cócteles"]);
  });

  it("sin sub-estación es válido: es la impresora de TODA la barra", () => {
    expect(
      invalidSubStations([{ station: "bar", barSubStation: null }], []),
    ).toEqual([]);
  });
});
