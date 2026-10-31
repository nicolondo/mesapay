import { describe, expect, it } from "vitest";
import { buildTrend, pointTicket } from "./trend";

describe("tendencia con comparación superpuesta", () => {
  it("rellena con cero los días sin venta y alinea la comparación por posición", () => {
    const points = buildTrend({
      rows: [
        { bucket: "2026-10-01", netCents: 100, orders: 1, diners: 2 },
        { bucket: "2026-10-03", netCents: 300, orders: 3, diners: 4 },
      ],
      range: { from: "2026-10-01", to: "2026-10-03" },
      compareRows: [{ bucket: "2026-09-29", netCents: 50, orders: 1, diners: 1 }],
      compareRange: { from: "2026-09-28", to: "2026-09-30" },
      granularity: "dia",
      cutoffHour: 5,
    });
    expect(points.map((p) => [p.bucket, p.netCents, p.compareBucket, p.compareNetCents])).toEqual([
      ["2026-10-01", 100, "2026-09-28", 0],
      ["2026-10-02", 0, "2026-09-29", 50],
      ["2026-10-03", 300, "2026-09-30", 0],
    ]);
  });

  it("un mes de 31 días contra uno de 30 deja el último punto sin pareja", () => {
    const points = buildTrend({
      rows: [],
      range: { from: "2026-10-01", to: "2026-10-31" },
      compareRows: [],
      compareRange: { from: "2026-09-01", to: "2026-09-30" },
      granularity: "dia",
      cutoffHour: 5,
    });
    expect(points).toHaveLength(31);
    expect(points.at(-1)).toMatchObject({ compareBucket: null, compareNetCents: null });
  });

  it("sin comparación todos los puntos quedan sin pareja", () => {
    const points = buildTrend({
      rows: [{ bucket: "2026-10-14T20", netCents: 10, orders: 1, diners: 1 }],
      range: { from: "2026-10-14", to: "2026-10-14" },
      compareRows: null,
      compareRange: null,
      granularity: "hora",
      cutoffHour: 5,
    });
    expect(points).toHaveLength(24);
    expect(points.find((p) => p.bucket === "2026-10-14T20")?.netCents).toBe(10);
    expect(points.every((p) => p.compareNetCents === null)).toBe(true);
  });

  it("ticket de un punto", () => {
    expect(pointTicket(1000, 3)).toBe(333);
    expect(pointTicket(1000, 0)).toBeNull();
    expect(pointTicket(null, 3)).toBeNull();
  });
});
