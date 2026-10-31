import { describe, expect, it } from "vitest";
import { buildHeatmap, heatLevel, HEAT_LEVELS } from "./heatmap";

describe("mapa de calor día × hora", () => {
  const rows = [
    { dow: 5, hour: 20, netCents: 8_000_000, orders: 10 },
    { dow: 5, hour: 1, netCents: 2_000_000, orders: 2 }, // madrugada del sábado = noche del viernes
    { dow: 6, hour: 13, netCents: 4_000_000, orders: 5 },
    { dow: 2, hour: 12, netCents: 500_000, orders: 1 },
  ];

  it("recorta las horas a la franja con ventas, en orden del día operativo (desde el corte)", () => {
    const h = buildHeatmap(rows, 5);
    expect(h.hours[0]).toBe(12);
    expect(h.hours.at(-1)).toBe(1);
    expect(h.hours).toEqual([12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0, 1]);
  });

  it("siete filas (lunes a domingo) y una celda por hora visible", () => {
    const h = buildHeatmap(rows, 5);
    expect(h.days).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(h.cells).toHaveLength(7);
    expect(h.cells.every((r) => r.length === h.hours.length)).toBe(true);
    const friday = h.cells[4]!;
    expect(friday.find((c) => c.hour === 1)).toMatchObject({ netCents: 2_000_000, orders: 2 });
  });

  it("nivel secuencial contra el máximo; cero sin venta", () => {
    const h = buildHeatmap(rows, 5);
    expect(h.maxNetCents).toBe(8_000_000);
    expect(h.peak).toMatchObject({ dow: 5, hour: 20, level: HEAT_LEVELS });
    expect(h.cells[0]!.every((c) => c.level === 0)).toBe(true);
    expect(heatLevel(4_000_000, 8_000_000)).toBe(3);
    expect(heatLevel(1, 8_000_000)).toBe(1);
    expect(heatLevel(0, 8_000_000)).toBe(0);
  });

  it("totales por día y por hora", () => {
    const h = buildHeatmap(rows, 5);
    expect(h.totalNetCents).toBe(14_500_000);
    expect(h.byDay.find((d) => d.dow === 5)).toEqual({ dow: 5, netCents: 10_000_000, orders: 12 });
    expect(h.byHour.find((x) => x.hour === 13)).toEqual({ hour: 13, netCents: 4_000_000, orders: 5 });
  });

  it("sin ventas: sin horas ni pico", () => {
    const h = buildHeatmap([], 5);
    expect(h.hours).toEqual([]);
    expect(h.peak).toBeNull();
  });

  it("ignora celdas imposibles y suma duplicadas", () => {
    const h = buildHeatmap([...rows, { dow: 9, hour: 3, netCents: 1, orders: 1 }, { dow: 5, hour: 20, netCents: 1_000_000, orders: 1 }], 5);
    expect(h.cells[4]!.find((c) => c.hour === 20)?.netCents).toBe(9_000_000);
  });
});
