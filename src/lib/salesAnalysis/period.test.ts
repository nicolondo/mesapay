import { describe, expect, it } from "vitest";
import { bogotaBusinessDateIso } from "@/lib/bogota";
import {
  addMonthsClamped,
  allowedGranularities,
  autoGranularity,
  bucketKeys,
  bucketRange,
  businessHourOrder,
  comparisonRange,
  isIsoDate,
  isoWeekday,
  presetRange,
  rangeDays,
  rangeInstants,
  resolveGranularity,
  weekStart,
} from "./period";

const TODAY = "2026-10-31"; // sábado

describe("presets en días operativos", () => {
  it.each([
    ["hoy", { from: "2026-10-31", to: "2026-10-31" }],
    ["ayer", { from: "2026-10-30", to: "2026-10-30" }],
    ["semana", { from: "2026-10-26", to: "2026-10-31" }],
    ["semana-pasada", { from: "2026-10-19", to: "2026-10-25" }],
    ["mes", { from: "2026-10-01", to: "2026-10-31" }],
    ["mes-pasado", { from: "2026-09-01", to: "2026-09-30" }],
    ["7d", { from: "2026-10-25", to: "2026-10-31" }],
    ["30d", { from: "2026-10-02", to: "2026-10-31" }],
    ["90d", { from: "2026-08-03", to: "2026-10-31" }],
    ["anio", { from: "2026-01-01", to: "2026-10-31" }],
  ] as const)("%s", (preset, expected) => {
    expect(presetRange(preset, TODAY)).toEqual(expected);
  });

  it("las semanas arrancan el lunes", () => {
    expect(isoWeekday("2026-10-26")).toBe(1);
    expect(isoWeekday("2026-11-01")).toBe(7);
    expect(weekStart("2026-11-01")).toBe("2026-10-26");
  });
});

describe("día operativo con corte a las 5 a. m.", () => {
  it("el día 14 va del 14 a las 05:00 al 15 a las 05:00 (hora Bogotá)", () => {
    const { start, end } = rangeInstants({ from: "2026-10-14", to: "2026-10-14" }, 5);
    expect(start.toISOString()).toBe("2026-10-14T10:00:00.000Z");
    expect(end.toISOString()).toBe("2026-10-15T10:00:00.000Z");
  });

  it("una venta a la 01:30 del 15 cuenta para el 14; a las 05:00 ya es del 15", () => {
    expect(bogotaBusinessDateIso(new Date("2026-10-15T01:30:00-05:00"), 5)).toBe("2026-10-14");
    expect(bogotaBusinessDateIso(new Date("2026-10-15T04:59:59-05:00"), 5)).toBe("2026-10-14");
    expect(bogotaBusinessDateIso(new Date("2026-10-15T05:00:00-05:00"), 5)).toBe("2026-10-15");
  });

  it("un rango de varios días cubre de la primera apertura al último corte", () => {
    const { start, end } = rangeInstants({ from: "2026-10-01", to: "2026-10-31" }, 5);
    expect(start.toISOString()).toBe("2026-10-01T10:00:00.000Z");
    expect(end.toISOString()).toBe("2026-11-01T10:00:00.000Z");
  });

  it("las horas del día operativo arrancan en el corte", () => {
    expect(businessHourOrder(5).slice(0, 3)).toEqual([5, 6, 7]);
    expect(businessHourOrder(5).slice(-2)).toEqual([3, 4]);
  });
});

describe("comparación de períodos", () => {
  it("anterior: mismo largo inmediatamente antes", () => {
    expect(comparisonRange({ from: "2026-10-02", to: "2026-10-31" }, "30d", "anterior"))
      .toEqual({ from: "2026-09-02", to: "2026-10-01" });
    expect(comparisonRange({ from: "2026-10-31", to: "2026-10-31" }, "hoy", "anterior"))
      .toEqual({ from: "2026-10-30", to: "2026-10-30" });
  });

  it("anterior: meses completos contra los meses completos anteriores", () => {
    expect(comparisonRange({ from: "2026-09-01", to: "2026-09-30" }, "mes-pasado", "anterior"))
      .toEqual({ from: "2026-08-01", to: "2026-08-31" });
    expect(comparisonRange({ from: "2026-03-01", to: "2026-03-31" }, "rango", "anterior"))
      .toEqual({ from: "2026-02-01", to: "2026-02-28" });
  });

  it("anterior: el mes en curso contra los mismos días del mes anterior", () => {
    expect(comparisonRange({ from: "2026-03-01", to: "2026-03-30" }, "mes", "anterior"))
      .toEqual({ from: "2026-02-01", to: "2026-02-28" });
  });

  it("anterior: esta semana contra los mismos días de la semana pasada", () => {
    expect(comparisonRange({ from: "2026-10-26", to: "2026-10-28" }, "semana", "anterior"))
      .toEqual({ from: "2026-10-19", to: "2026-10-21" });
  });

  it("año anterior: mismas fechas, el 29 de febrero cae en el 28", () => {
    expect(comparisonRange({ from: "2028-02-29", to: "2028-03-05" }, "rango", "anio"))
      .toEqual({ from: "2027-02-28", to: "2027-03-05" });
    expect(comparisonRange({ from: "2026-01-01", to: "2026-10-31" }, "anio", "anterior"))
      .toEqual({ from: "2025-01-01", to: "2025-10-31" });
  });

  it("año anterior con meses completos: el mes entero (febrero bisiesto incluido)", () => {
    expect(comparisonRange({ from: "2029-02-01", to: "2029-02-28" }, "mes-pasado", "anio"))
      .toEqual({ from: "2028-02-01", to: "2028-02-29" });
  });

  it("sin comparación", () => {
    expect(comparisonRange({ from: "2026-10-01", to: "2026-10-31" }, "mes", "no")).toBeNull();
  });

  it("addMonthsClamped recorta al largo del mes", () => {
    expect(addMonthsClamped("2026-03-31", -1)).toBe("2026-02-28");
    expect(addMonthsClamped("2026-01-15", -13)).toBe("2024-12-15");
  });
});

describe("granularidad", () => {
  it("automática según el largo", () => {
    expect(autoGranularity({ from: "2026-10-14", to: "2026-10-14" })).toBe("hora");
    expect(autoGranularity({ from: "2026-10-01", to: "2026-10-31" })).toBe("dia");
    expect(autoGranularity({ from: "2026-08-03", to: "2026-10-31" })).toBe("semana");
    expect(autoGranularity({ from: "2026-01-01", to: "2026-10-31" })).toBe("mes");
  });

  it("sólo ofrece las que tienen sentido y cae a la automática si piden otra", () => {
    expect(allowedGranularities({ from: "2026-10-14", to: "2026-10-14" })).toEqual(["hora"]);
    expect(allowedGranularities({ from: "2026-10-25", to: "2026-10-31" })).toEqual(["hora", "dia"]);
    expect(resolveGranularity({ from: "2026-01-01", to: "2026-10-31" }, "hora")).toBe("mes");
    expect(resolveGranularity({ from: "2026-01-01", to: "2026-10-31" }, "dia")).toBe("dia");
  });

  it("baldes de todo el rango, en orden", () => {
    expect(bucketKeys({ from: "2026-10-30", to: "2026-11-02" }, "dia", 5))
      .toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
    expect(bucketKeys({ from: "2026-10-28", to: "2026-11-10" }, "semana", 5))
      .toEqual(["2026-10-26", "2026-11-02", "2026-11-09"]);
    expect(bucketKeys({ from: "2026-09-15", to: "2026-11-02" }, "mes", 5)).toEqual(["2026-09", "2026-10", "2026-11"]);
    const hours = bucketKeys({ from: "2026-10-14", to: "2026-10-14" }, "hora", 5);
    expect(hours).toHaveLength(24);
    expect(hours[0]).toBe("2026-10-14T05");
    expect(hours[23]).toBe("2026-10-14T04");
  });

  it("drill de un balde: recortado al rango consultado", () => {
    const within = { from: "2026-10-28", to: "2026-11-10" };
    expect(bucketRange("2026-10-26", "semana", within)).toEqual({ from: "2026-10-28", to: "2026-11-01" });
    expect(bucketRange("2026-11", "mes", within)).toEqual({ from: "2026-11-01", to: "2026-11-10" });
    expect(bucketRange("2026-10-30T22", "hora", within)).toEqual({ from: "2026-10-30", to: "2026-10-30" });
  });
});

describe("fechas", () => {
  it("valida fechas reales", () => {
    expect(isIsoDate("2026-02-28")).toBe(true);
    expect(isIsoDate("2026-02-29")).toBe(false);
    expect(isIsoDate("2026-13-01")).toBe(false);
    expect(isIsoDate("hoy")).toBe(false);
  });

  it("cuenta días con ambos extremos", () => {
    expect(rangeDays({ from: "2026-10-01", to: "2026-10-31" })).toBe(31);
  });
});
