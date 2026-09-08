import { describe, it, expect } from "vitest";
import {
  currentMonthRange,
  dinerOrdersWhere,
  isIsoDate,
  isoRangeToDates,
  resolveRange,
} from "./monthRange";

describe("currentMonthRange", () => {
  it("devuelve el primero y el último día del mes", () => {
    expect(currentMonthRange(new Date("2026-03-17T15:00:00Z"))).toEqual({
      from: "2026-03-01",
      to: "2026-03-31",
    });
    expect(currentMonthRange(new Date("2026-04-02T15:00:00Z"))).toEqual({
      from: "2026-04-01",
      to: "2026-04-30",
    });
  });

  it("acierta en febrero bisiesto", () => {
    expect(currentMonthRange(new Date("2028-02-10T15:00:00Z"))).toEqual({
      from: "2028-02-01",
      to: "2028-02-29",
    });
  });

  it("usa la zona del comercio, no UTC", () => {
    // 1 de abril 02:00 UTC son las 21:00 del 31 de marzo en Bogotá. Si
    // resolviéramos en UTC, el operador vería "abril" cuando en su local
    // todavía es marzo — y el cierre del mes no cuadraría.
    expect(currentMonthRange(new Date("2026-04-01T02:00:00Z"))).toEqual({
      from: "2026-03-01",
      to: "2026-03-31",
    });
  });
});

describe("isIsoDate", () => {
  it("acepta YYYY-MM-DD y rechaza el resto", () => {
    expect(isIsoDate("2026-03-01")).toBe(true);
    expect(isIsoDate("01/03/2026")).toBe(false);
    expect(isIsoDate("")).toBe(false);
    expect(isIsoDate(null)).toBe(false);
    expect(isIsoDate(undefined)).toBe(false);
  });
});

describe("isoRangeToDates", () => {
  it("hace el 'hasta' inclusivo", () => {
    // Quien escribe 31 de marzo espera ver lo del 31 de marzo completo.
    const { gte, lt } = isoRangeToDates("2026-03-01", "2026-03-31");
    expect(gte.toISOString()).toBe("2026-03-01T05:00:00.000Z");
    expect(lt.toISOString()).toBe("2026-04-01T05:00:00.000Z");
  });
});

describe("resolveRange", () => {
  const ref = new Date("2026-03-17T15:00:00Z");

  it("cae al mes en curso cuando no viene nada", () => {
    expect(resolveRange(undefined, undefined, ref)).toEqual({
      from: "2026-03-01",
      to: "2026-03-31",
    });
  });

  it("cae al mes en curso cuando el formato es basura", () => {
    expect(resolveRange("ayer", "hoy", ref)).toEqual({
      from: "2026-03-01",
      to: "2026-03-31",
    });
  });

  it("respeta un rango válido", () => {
    expect(resolveRange("2026-01-05", "2026-02-10", ref)).toEqual({
      from: "2026-01-05",
      to: "2026-02-10",
    });
  });

  it("ordena un rango invertido en vez de devolver vacío", () => {
    expect(resolveRange("2026-02-10", "2026-01-05", ref)).toEqual({
      from: "2026-01-05",
      to: "2026-02-10",
    });
  });
});

describe("dinerOrdersWhere", () => {
  it("SIEMPRE filtra por restaurante", () => {
    // Este test es el guardarraíl del aislamiento entre restaurantes. El
    // dinerId llega por la URL: sin este filtro, un operador podría pegar
    // el id de un comensal de otro local y ver sus facturas. Si alguien
    // quita el restaurantId, esto falla.
    const where = dinerOrdersWhere({
      restaurantId: "rest_A",
      dinerId: "diner_1",
      from: "2026-03-01",
      to: "2026-03-31",
    });
    expect(where.restaurantId).toBe("rest_A");
    expect(where.dinerId).toBe("diner_1");
    expect(Object.keys(where)).toContain("restaurantId");
  });

  it("solo cuenta facturas pagadas dentro del rango", () => {
    const where = dinerOrdersWhere({
      restaurantId: "rest_A",
      dinerId: "diner_1",
      from: "2026-03-01",
      to: "2026-03-31",
    });
    expect(where.status).toBe("paid");
    expect(where.paidAt.gte.toISOString()).toBe("2026-03-01T05:00:00.000Z");
    expect(where.paidAt.lt.toISOString()).toBe("2026-04-01T05:00:00.000Z");
  });
});
