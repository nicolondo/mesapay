// Días de negocio de un mes: con la hora de corte del comercio, cada día va
// de las HH:00 de Bogotá de ese día a las HH:00 del siguiente; el mes de
// negocio es la unión de sus días y la fecha del asiento diario es la
// medianoche de Bogotá del día.
import { describe, expect, it } from "vitest";
import { bogotaBusinessDateIso } from "@/lib/bogota";
import {
  businessDaysOfMonth,
  businessMonthRange,
  calendarDayOf,
  dailyEntryDate,
} from "./businessDays";

describe("businessDaysOfMonth", () => {
  it("octubre con corte 5: 31 días, del 1 a las 05:00 Bogotá (10:00Z) al 1-nov a las 10:00Z", () => {
    const days = businessDaysOfMonth("2026-10", 5);
    expect(days).toHaveLength(31);
    expect(days[0]).toEqual({
      day: "2026-10-01",
      from: new Date("2026-10-01T10:00:00.000Z"),
      to: new Date("2026-10-02T10:00:00.000Z"),
    });
    expect(days[30]).toEqual({
      day: "2026-10-31",
      from: new Date("2026-10-31T10:00:00.000Z"),
      to: new Date("2026-11-01T10:00:00.000Z"),
    });
    // Días contiguos sin huecos ni solapes.
    for (let i = 1; i < days.length; i++) {
      expect(days[i]!.from.getTime()).toBe(days[i - 1]!.to.getTime());
    }
  });

  it("sin corte (0) el día arranca a la medianoche de Bogotá (05:00Z)", () => {
    const days = businessDaysOfMonth("2026-10", 0);
    expect(days[0]!.from).toEqual(new Date("2026-10-01T05:00:00.000Z"));
    expect(days[30]!.to).toEqual(new Date("2026-11-01T05:00:00.000Z"));
  });

  it("cambio de año: diciembre termina el 1 de enero", () => {
    const days = businessDaysOfMonth("2026-12", 5);
    expect(days).toHaveLength(31);
    expect(days[30]!.day).toBe("2026-12-31");
    expect(days[30]!.to).toEqual(new Date("2027-01-01T10:00:00.000Z"));
  });

  it("febrero: 29 días en bisiesto, 28 si no", () => {
    expect(businessDaysOfMonth("2024-02", 5)).toHaveLength(29);
    expect(businessDaysOfMonth("2024-02", 5)[28]!.day).toBe("2024-02-29");
    expect(businessDaysOfMonth("2026-02", 5)).toHaveLength(28);
    expect(businessDaysOfMonth("2026-02", 5)[27]!.to).toEqual(new Date("2026-03-01T10:00:00.000Z"));
  });

  it("un mes inválido no tiene días", () => {
    expect(businessDaysOfMonth("2026-13", 5)).toEqual([]);
    expect(businessDaysOfMonth("2019-12", 5)).toEqual([]);
    expect(businessDaysOfMonth("octubre", 5)).toEqual([]);
    expect(businessMonthRange("2026-00", 5)).toBeNull();
  });

  it("cada instante de un día cae en ese día según bogotaBusinessDateIso (misma regla del cierre de día)", () => {
    for (const d of businessDaysOfMonth("2026-10", 5)) {
      expect(bogotaBusinessDateIso(d.from, 5)).toBe(d.day);
      expect(bogotaBusinessDateIso(new Date(d.to.getTime() - 1), 5)).toBe(d.day);
      expect(bogotaBusinessDateIso(d.to, 5)).not.toBe(d.day);
    }
  });
});

describe("businessMonthRange", () => {
  it("va del comienzo del primer día al final del último (no es el mes UTC)", () => {
    expect(businessMonthRange("2026-10", 5)).toEqual({
      from: new Date("2026-10-01T10:00:00.000Z"),
      to: new Date("2026-11-01T10:00:00.000Z"),
    });
  });
});

describe("dailyEntryDate", () => {
  it("es la medianoche de Bogotá del día: cae dentro del día calendario UTC y del mes UTC", () => {
    const date = dailyEntryDate("2026-10-31");
    expect(date.toISOString()).toBe("2026-10-31T05:00:00.000Z");
    // Dentro del mes UTC de octubre (lo que cortan reportes, cierre y Diario).
    expect(date.getTime()).toBeLessThan(Date.UTC(2026, 10, 1));
    expect(date.getTime()).toBeGreaterThanOrEqual(Date.UTC(2026, 9, 31));
    // Y es el mismo día calendario en Bogotá.
    expect(bogotaBusinessDateIso(date, 0)).toBe("2026-10-31");
  });
});

describe("calendarDayOf", () => {
  it("un campo FECHA (medianoche o mediodía UTC) se lee por su día UTC, nunca restando el corte", () => {
    expect(calendarDayOf(new Date("2026-10-01T00:00:00.000Z"))).toBe("2026-10-01");
    expect(calendarDayOf(new Date("2026-10-01T17:00:00.000Z"))).toBe("2026-10-01");
    // Con el corte de negocio, la medianoche UTC caería el 30-sep: justo lo que no queremos.
    expect(bogotaBusinessDateIso(new Date("2026-10-01T00:00:00.000Z"), 5)).toBe("2026-09-30");
  });
});
