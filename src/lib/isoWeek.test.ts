import { describe, expect, it } from "vitest";
import { isoWeekNumber } from "./isoWeek";

describe("isoWeekNumber", () => {
  it("la semana del 26 oct – 1 nov de 2026 es la 44", () => {
    expect(isoWeekNumber("2026-10-26")).toEqual({ year: 2026, week: 44 });
    expect(isoWeekNumber("2026-11-01")).toEqual({ year: 2026, week: 44 });
    expect(isoWeekNumber("2026-11-02")).toEqual({ year: 2026, week: 45 });
  });

  it("la semana 1 es la que contiene el primer jueves", () => {
    // 2026-01-01 es jueves → semana 1 de 2026 arranca el lunes 2025-12-29.
    expect(isoWeekNumber("2025-12-29")).toEqual({ year: 2026, week: 1 });
    expect(isoWeekNumber("2026-01-01")).toEqual({ year: 2026, week: 1 });
    // 2027-01-01 es viernes → sigue en la semana 53 de 2026.
    expect(isoWeekNumber("2027-01-01")).toEqual({ year: 2026, week: 53 });
    expect(isoWeekNumber("2027-01-04")).toEqual({ year: 2027, week: 1 });
  });

  it("acepta un instante ISO y usa sólo la fecha", () => {
    expect(isoWeekNumber("2026-10-31T23:59:59.999Z")).toEqual({ year: 2026, week: 44 });
  });
});
