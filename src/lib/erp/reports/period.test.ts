import { describe, expect, it } from "vitest";
import {
  currentMonthPeriod,
  isIsoDate,
  monthRangeUtc,
  periodKind,
  periodToUtcRange,
  resolveReportPeriod,
  shiftPeriod,
  snapPeriod,
  todayIso,
  weekRangeUtc,
} from "./period";

const today = "2026-09-21";

describe("resolveReportPeriod — prioridades", () => {
  it("sin nada: 1 de enero del año en curso → hoy", () => {
    expect(resolveReportPeriod({ today })).toEqual({
      desde: "2026-01-01",
      hasta: "2026-09-21",
      year: null,
      mode: "rango",
    });
  });

  it("anio sin fechas: el ejercicio completo", () => {
    expect(resolveReportPeriod({ anio: "2025", today })).toEqual({
      desde: "2025-01-01",
      hasta: "2025-12-31",
      year: 2025,
      mode: "ejercicio",
    });
  });

  it("desde/hasta explícitos mandan sobre anio", () => {
    const p = resolveReportPeriod({ anio: "2024", desde: "2026-03-01", hasta: "2026-03-31", today });
    expect(p).toMatchObject({ desde: "2026-03-01", hasta: "2026-03-31", year: null, mode: "rango" });
  });

  it("rellena el extremo que falte", () => {
    expect(resolveReportPeriod({ desde: "2026-05-01", today })).toMatchObject({
      desde: "2026-05-01",
      hasta: today,
    });
    expect(resolveReportPeriod({ hasta: "2026-05-31", today })).toMatchObject({
      desde: "2026-01-01",
      hasta: "2026-05-31",
    });
  });

  it("reconoce un ejercicio escrito a mano", () => {
    const p = resolveReportPeriod({ desde: "2025-01-01", hasta: "2025-12-31", today });
    expect(p.year).toBe(2025);
    expect(p.mode).toBe("ejercicio");
  });

  it("ignora fechas inválidas y años fuera de rango", () => {
    expect(resolveReportPeriod({ desde: "2026-02-31", hasta: "no", anio: "1999", today })).toEqual(
      resolveReportPeriod({ today }),
    );
  });
});

describe("isIsoDate", () => {
  it("acepta solo fechas reales", () => {
    expect(isIsoDate("2026-02-28")).toBe(true);
    expect(isIsoDate("2026-02-31")).toBe(false);
    expect(isIsoDate("2026-13-01")).toBe(false);
    expect(isIsoDate("26-01-01")).toBe(false);
    expect(isIsoDate(undefined)).toBe(false);
  });
});

describe("shiftPeriod", () => {
  it("salta de mes completo, incluso cruzando el año y en febrero", () => {
    expect(shiftPeriod({ desde: "2026-01-15", hasta: "2026-01-20" }, "mes", -1)).toEqual({
      desde: "2025-12-01",
      hasta: "2025-12-31",
    });
    expect(shiftPeriod({ desde: "2026-01-01", hasta: "2026-01-31" }, "mes", 1)).toEqual({
      desde: "2026-02-01",
      hasta: "2026-02-28",
    });
  });

  it("salta de año completo", () => {
    expect(shiftPeriod({ desde: "2026-03-01", hasta: "2026-09-21" }, "año", 1)).toEqual({
      desde: "2027-01-01",
      hasta: "2027-12-31",
    });
  });

  it("salta de semana completa (lunes a domingo) desde un rango libre", () => {
    // 2026-11-02 es lunes; el rango libre arranca un miércoles.
    expect(shiftPeriod({ desde: "2026-11-04", hasta: "2026-11-20" }, "semana", -1)).toEqual({
      desde: "2026-10-26",
      hasta: "2026-11-01",
    });
    expect(shiftPeriod({ desde: "2026-11-02", hasta: "2026-11-08" }, "semana", 1)).toEqual({
      desde: "2026-11-09",
      hasta: "2026-11-15",
    });
  });
});

describe("weekRangeUtc", () => {
  it("lunes a domingo de la semana del día, cruzando mes y año", () => {
    expect(weekRangeUtc("2026-11-02")).toEqual({ desde: "2026-11-02", hasta: "2026-11-08" });
    expect(weekRangeUtc("2026-11-08")).toEqual({ desde: "2026-11-02", hasta: "2026-11-08" });
    expect(weekRangeUtc("2026-11-01")).toEqual({ desde: "2026-10-26", hasta: "2026-11-01" });
    expect(weekRangeUtc("2027-01-01")).toEqual({ desde: "2026-12-28", hasta: "2027-01-03" });
  });
});

describe("periodKind", () => {
  it("reconoce año, mes y semana completos; lo demás es rango", () => {
    expect(periodKind({ desde: "2026-01-01", hasta: "2026-12-31" })).toBe("año");
    expect(periodKind({ desde: "2026-02-01", hasta: "2026-02-28" })).toBe("mes");
    expect(periodKind({ desde: "2026-11-02", hasta: "2026-11-08" })).toBe("semana");
    expect(periodKind({ desde: "2026-01-01", hasta: "2026-11-02" })).toBe("rango");
    // Siete días que no empiezan en lunes no son una «semana».
    expect(periodKind({ desde: "2026-11-03", hasta: "2026-11-09" })).toBe("rango");
    // Un mes recortado tampoco es «mes».
    expect(periodKind({ desde: "2026-02-01", hasta: "2026-02-27" })).toBe("rango");
  });
});

describe("snapPeriod", () => {
  const hoy = "2026-11-02";

  it("si hoy cae en el rango, va a la unidad que contiene hoy", () => {
    const ytd = { desde: "2026-01-01", hasta: "2026-11-02" };
    expect(snapPeriod(ytd, "mes", hoy)).toEqual({ desde: "2026-11-01", hasta: "2026-11-30" });
    expect(snapPeriod(ytd, "semana", hoy)).toEqual({ desde: "2026-11-02", hasta: "2026-11-08" });
    expect(snapPeriod(ytd, "año", hoy)).toEqual({ desde: "2026-01-01", hasta: "2026-12-31" });
  });

  it("si hoy queda fuera, ancla en el final del rango", () => {
    const octubre = { desde: "2026-10-01", hasta: "2026-10-31" };
    expect(snapPeriod(octubre, "semana", hoy)).toEqual({ desde: "2026-10-26", hasta: "2026-11-01" });
    expect(snapPeriod({ desde: "2025-01-01", hasta: "2025-12-31" }, "mes", hoy)).toEqual({
      desde: "2025-12-01",
      hasta: "2025-12-31",
    });
  });
});

describe("monthRangeUtc / currentMonthPeriod / periodToUtcRange", () => {
  it("mes completo con último día correcto (bisiesto incluido)", () => {
    expect(monthRangeUtc("2024-02")).toEqual({ desde: "2024-02-01", hasta: "2024-02-29" });
    expect(monthRangeUtc("2026-13")).toBeNull();
    expect(monthRangeUtc("x")).toBeNull();
    expect(currentMonthPeriod(today)).toEqual({ desde: "2026-09-01", hasta: "2026-09-30" });
  });

  it("límites UTC: desde inclusivo, hasta exclusivo al día siguiente", () => {
    const r = periodToUtcRange({ desde: "2026-08-01", hasta: "2026-08-31" });
    expect(r.from.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(r.to.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    // El asiento-resumen de agosto (último instante UTC del mes) cae DENTRO.
    const augustEntry = new Date(Date.UTC(2026, 8, 1) - 1);
    expect(augustEntry >= r.from && augustEntry < r.to).toBe(true);
  });
});

describe("todayIso", () => {
  it("lee la fecha en la zona del comercio (Bogotá)", () => {
    // 2026-09-22T03:00Z todavía es 21 de septiembre en Bogotá (UTC−5).
    expect(todayIso(new Date("2026-09-22T03:00:00Z"))).toBe("2026-09-21");
    expect(todayIso(new Date("2026-09-22T06:00:00Z"))).toBe("2026-09-22");
  });
});
