import { describe, expect, it } from "vitest";
import {
  buildYearStatus,
  formatMonthLong,
  isMonth,
  monthsOfYear,
  nextMonthOf,
  nextMonthToClose,
  parseYearParam,
} from "./cierrePeriodo";

describe("meses", () => {
  it("nextMonthOf cruza el año", () => {
    expect(nextMonthOf("2026-01")).toBe("2026-02");
    expect(nextMonthOf("2025-12")).toBe("2026-01");
  });

  it("monthsOfYear da los 12 con cero a la izquierda", () => {
    const m = monthsOfYear(2026);
    expect(m).toHaveLength(12);
    expect(m[0]).toBe("2026-01");
    expect(m[11]).toBe("2026-12");
  });

  it("isMonth valida forma y rango", () => {
    expect(isMonth("2026-09")).toBe(true);
    expect(isMonth("2026-13")).toBe(false);
    expect(isMonth("2026-9")).toBe(false);
    expect(isMonth(null)).toBe(false);
  });
});

describe("parseYearParam", () => {
  it("acepta un año de cuatro cifras dentro del rango", () => {
    expect(parseYearParam("2025", 2026)).toBe(2025);
    expect(parseYearParam(["2027", "2020"], 2026)).toBe(2027);
  });

  it("cae al año en curso con basura, vacío o fuera de rango", () => {
    expect(parseYearParam(undefined, 2026)).toBe(2026);
    expect(parseYearParam("", 2026)).toBe(2026);
    expect(parseYearParam("abcd", 2026)).toBe(2026);
    expect(parseYearParam("2019", 2026)).toBe(2026);
    expect(parseYearParam("2028", 2026)).toBe(2026);
    expect(parseYearParam("20260", 2026)).toBe(2026);
  });
});

describe("nextMonthToClose", () => {
  it("sigue al último cerrado; sin cierres arranca en el primer mes con comprobantes", () => {
    expect(nextMonthToClose("2026-03", "2025-11")).toBe("2026-04");
    expect(nextMonthToClose(null, "2025-11")).toBe("2025-11");
    expect(nextMonthToClose(null, null)).toBeNull();
  });
});

describe("buildYearStatus", () => {
  const counts = [
    { month: "2026-01", entries: 4, numbered: 4 },
    { month: "2026-02", entries: 3, numbered: 3 },
    { month: "2026-03", entries: 5, numbered: 0 },
    { month: "2026-09", entries: 1, numbered: 0 },
  ];

  it("marca cerrados hasta closedThrough, futuros después del mes en curso y el botón en el siguiente", () => {
    const s = buildYearStatus({
      year: 2026,
      closedThrough: "2026-02",
      counts,
      currentMonth: "2026-09",
      firstEntryMonth: "2026-01",
    });
    expect(s.months).toHaveLength(12);
    expect(s.months.map((m) => m.closed)).toEqual([
      true, true, false, false, false, false, false, false, false, false, false, false,
    ]);
    expect(s.months.map((m) => m.future)).toEqual([
      false, false, false, false, false, false, false, false, false, true, true, true,
    ]);
    expect(s.nextToClose).toBe("2026-03");
    expect(s.months.filter((m) => m.canClose).map((m) => m.month)).toEqual(["2026-03"]);
    expect(s.months[2]).toMatchObject({ entries: 5, numbered: 0 });
    expect(s.months[5]).toMatchObject({ entries: 0, numbered: 0 });
    expect(s.closedInYear).toBe(2);
    expect(s.allClosed).toBe(false);
  });

  it("sin cierres previos el botón va en el primer mes con comprobantes", () => {
    const s = buildYearStatus({
      year: 2026,
      closedThrough: null,
      counts,
      currentMonth: "2026-09",
      firstEntryMonth: "2026-01",
    });
    expect(s.nextToClose).toBe("2026-01");
    expect(s.months.filter((m) => m.canClose).map((m) => m.month)).toEqual(["2026-01"]);
  });

  it("sin comprobantes no hay nada que cerrar", () => {
    const s = buildYearStatus({
      year: 2026,
      closedThrough: null,
      counts: [],
      currentMonth: "2026-09",
      firstEntryMonth: null,
    });
    expect(s.nextToClose).toBeNull();
    expect(s.months.some((m) => m.canClose)).toBe(false);
  });

  it("si el próximo a cerrar cae en otro año, ningún mes del año mostrado lleva el botón", () => {
    const s = buildYearStatus({
      year: 2026,
      closedThrough: "2025-06",
      counts,
      currentMonth: "2026-09",
      firstEntryMonth: "2025-01",
    });
    expect(s.nextToClose).toBe("2025-07");
    expect(s.months.some((m) => m.canClose)).toBe(false);
    expect(s.months.every((m) => !m.closed)).toBe(true);
  });

  it("un año completamente cerrado no ofrece cerrar y allClosed es true", () => {
    const s = buildYearStatus({
      year: 2025,
      closedThrough: "2025-12",
      counts: [],
      currentMonth: "2026-09",
      firstEntryMonth: "2025-01",
    });
    expect(s.allClosed).toBe(true);
    expect(s.nextToClose).toBe("2026-01");
    expect(s.months.some((m) => m.canClose)).toBe(false);
  });

  it("el próximo mes no se puede cerrar si todavía es futuro", () => {
    const s = buildYearStatus({
      year: 2026,
      closedThrough: "2026-09",
      counts: [],
      currentMonth: "2026-09",
      firstEntryMonth: "2026-01",
    });
    expect(s.nextToClose).toBe("2026-10");
    expect(s.months.some((m) => m.canClose)).toBe(false);
  });
});

describe("formatMonthLong", () => {
  it("mes largo con año, capitalizado, sin correrse por zona horaria", () => {
    expect(formatMonthLong("2026-01", "es")).toBe("Enero de 2026");
    expect(formatMonthLong("2026-12", "en")).toBe("December 2026");
    expect(formatMonthLong("2026-03", "pt")).toBe("Março de 2026");
  });
});
