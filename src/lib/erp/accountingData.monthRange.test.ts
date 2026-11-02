// El rango contable de un mes: `from`/`to` = mes de NEGOCIO del comercio
// (para los hechos con timestamp) y `calendar` = mes calendario UTC (para
// lo que vive en una FECHA). Es lo que las tarjetas de Contabilidad pasan a
// las agregaciones para cuadrar con el libro, cuyos asientos diarios van por
// día de negocio.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ restaurant: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { restaurant: { findUnique: m.restaurant } } }));

import { accountingMonthRange, calendarRangeOf } from "./accountingData";

beforeEach(() => {
  vi.resetAllMocks();
  m.restaurant.mockResolvedValue({ businessDayCutoffHour: 5 });
});

describe("accountingMonthRange", () => {
  it("octubre con corte 5: del 1-oct 05:00 Bogotá al 1-nov 05:00 Bogotá, más el mes calendario UTC", async () => {
    const range = await accountingMonthRange("r1", "2026-10");
    expect(range).toEqual({
      from: new Date("2026-10-01T10:00:00.000Z"),
      to: new Date("2026-11-01T10:00:00.000Z"),
      calendar: { from: new Date("2026-10-01T00:00:00.000Z"), to: new Date("2026-11-01T00:00:00.000Z") },
    });
    expect(m.restaurant).toHaveBeenCalledWith({ where: { id: "r1" }, select: { businessDayCutoffHour: true } });
  });

  it("sin hora de corte (comercio sin fila o corte 0): medianoche de Bogotá", async () => {
    m.restaurant.mockResolvedValue(null);
    const range = await accountingMonthRange("r1", "2026-12");
    expect(range?.from).toEqual(new Date("2026-12-01T05:00:00.000Z"));
    expect(range?.to).toEqual(new Date("2027-01-01T05:00:00.000Z"));
  });

  it("un mes inválido es null (sin consultar la base)", async () => {
    expect(await accountingMonthRange("r1", "2026-13")).toBeNull();
    expect(await accountingMonthRange("r1", "octubre")).toBeNull();
    expect(m.restaurant).not.toHaveBeenCalled();
  });
});

describe("calendarRangeOf", () => {
  it("devuelve el calendario si viene y, si no, el propio rango (comportamiento histórico)", () => {
    const calendar = { from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-11-01T00:00:00Z") };
    const business = { from: new Date("2026-10-01T10:00:00Z"), to: new Date("2026-11-01T10:00:00Z"), calendar };
    expect(calendarRangeOf(business)).toEqual(calendar);
    expect(calendarRangeOf(calendar)).toEqual(calendar);
  });
});
