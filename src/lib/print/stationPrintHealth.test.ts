import { describe, expect, it } from "vitest";
import {
  printerBlockedByStation,
  stationPrintHealth,
  stationsMissingPrinter,
  type HealthPrinter,
} from "./stationPrintHealth";

const printer = (over: Partial<HealthPrinter> = {}): HealthPrinter => ({
  kind: "comanda",
  station: "kitchen",
  barSubStation: null,
  active: true,
  ...over,
});

const FLAGS = {
  kitchenPrintEnabled: true,
  barPrintEnabled: true,
  kitchenAutoFire: false,
  barAutoFire: false,
};

describe("stationPrintHealth", () => {
  it("el caso real: impresión del bar encendida y sólo hay impresora de cocina", () => {
    const h = stationPrintHealth({ ...FLAGS, printers: [printer()] });
    expect(h.kitchen).toMatchObject({ activePrinters: 1, issues: [] });
    expect(h.bar).toMatchObject({
      activePrinters: 0,
      issues: ["print_on_no_printer"],
    });
    expect(stationsMissingPrinter(h)).toEqual(["bar"]);
  });

  it("el otro caso real: impresora de bar activa con la impresión del bar apagada", () => {
    const bar = printer({ station: "bar" });
    const h = stationPrintHealth({
      ...FLAGS,
      barPrintEnabled: false,
      printers: [printer(), bar],
    });
    expect(h.bar.issues).toEqual(["printer_print_off"]);
    expect(printerBlockedByStation(bar, h)).toBe("bar");
    expect(printerBlockedByStation(printer(), h)).toBeNull();
    expect(stationsMissingPrinter(h)).toEqual([]);
  });

  it("sin ninguna impresora registrada no alarma: ese local imprime desde la pestaña", () => {
    const h = stationPrintHealth({ ...FLAGS, printers: [] });
    expect(h.kitchen.issues).toEqual([]);
    expect(h.bar.issues).toEqual([]);
    expect(h.kitchen.activePrinters).toBe(0);
  });

  it("una impresora apagada por reparación sigue contando como 'usa impresoras de red'", () => {
    const h = stationPrintHealth({
      ...FLAGS,
      barPrintEnabled: false,
      barAutoFire: false,
      printers: [printer({ active: false })],
    });
    expect(h.kitchen).toMatchObject({
      activePrinters: 0,
      issues: ["print_on_no_printer"],
    });
  });

  it("la impresora de factura no cuenta para ninguna estación", () => {
    const h = stationPrintHealth({
      ...FLAGS,
      printers: [printer({ kind: "factura", station: null })],
    });
    expect(h.kitchen.activePrinters).toBe(0);
    expect(h.kitchen.issues).toEqual(["print_on_no_printer"]);
    expect(
      printerBlockedByStation(printer({ kind: "factura", station: null }), h),
    ).toBeNull();
  });

  it("marchado automático con la impresión apagada avisa, sin importar las impresoras", () => {
    const h = stationPrintHealth({
      ...FLAGS,
      barPrintEnabled: false,
      barAutoFire: true,
      printers: [],
    });
    expect(h.bar.issues).toEqual(["auto_fire_print_off"]);
    expect(h.kitchen.issues).toEqual([]);
  });

  it("marchado automático con impresión encendida y su impresora no avisa nada", () => {
    const h = stationPrintHealth({
      ...FLAGS,
      barAutoFire: true,
      printers: [printer(), printer({ station: "bar" })],
    });
    expect(h.bar.issues).toEqual([]);
  });

  describe("sub-estaciones del bar", () => {
    it("una impresora 'de toda la barra' cubre todas las sub-estaciones", () => {
      const h = stationPrintHealth({
        ...FLAGS,
        barSubStations: ["cocteles", "cafe"],
        printers: [printer({ station: "bar" })],
      });
      expect(h.bar).toMatchObject({
        activePrinters: 1,
        uncoveredBarSubStations: [],
        issues: [],
      });
    });

    it("con impresoras sólo de algunas sub-estaciones, las otras quedan sin comanda", () => {
      const h = stationPrintHealth({
        ...FLAGS,
        barSubStations: ["cocteles", "cafe"],
        printers: [
          printer(),
          printer({ station: "bar", barSubStation: "cocteles" }),
        ],
      });
      expect(h.bar).toMatchObject({
        activePrinters: 1,
        uncoveredBarSubStations: ["cafe"],
        issues: ["print_on_sub_uncovered"],
      });
      expect(stationsMissingPrinter(h)).toEqual(["bar"]);
    });

    it("una impresora apagada no cubre su sub-estación", () => {
      const h = stationPrintHealth({
        ...FLAGS,
        barSubStations: ["cocteles"],
        printers: [
          printer({ station: "bar" }),
          printer({ station: "bar", barSubStation: "cocteles", active: false }),
        ],
      });
      // La "de toda la barra" sigue cubriendo; la apagada no suma.
      expect(h.bar.activePrinters).toBe(1);
      expect(h.bar.uncoveredBarSubStations).toEqual([]);
    });

    it("sin impresora ninguna manda 'sin impresora', no una lista de sub-estaciones", () => {
      const h = stationPrintHealth({
        ...FLAGS,
        barSubStations: ["cocteles", "cafe"],
        printers: [printer()],
      });
      expect(h.bar.uncoveredBarSubStations).toEqual(["cocteles", "cafe"]);
      expect(h.bar.issues).toEqual(["print_on_no_printer"]);
    });

    it("con la impresión del bar apagada la cobertura no genera avisos", () => {
      const h = stationPrintHealth({
        ...FLAGS,
        barPrintEnabled: false,
        barSubStations: ["cocteles", "cafe"],
        printers: [printer({ station: "bar", barSubStation: "cocteles" })],
      });
      expect(h.bar.issues).toEqual(["printer_print_off"]);
    });
  });
});
