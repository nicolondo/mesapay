import { afterEach, describe, expect, it, vi } from "vitest";
import { orderPeriodStart } from "./periodStart";

/** Fija "ahora" en una hora Bogotá (UTC−5). */
function setBogotaNow(iso: string) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(`${iso}-05:00`));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("orderPeriodStart", () => {
  it("con corte 5, la madrugada cuenta para el día anterior", () => {
    // 27/09 01:28 Bogotá: todavía es la jornada del 26.
    setBogotaNow("2026-09-27T01:28:00");
    expect(orderPeriodStart("today", 5)?.toISOString()).toBe("2026-09-26T10:00:00.000Z");
  });

  it("con corte 5, después de las 05:00 arranca la jornada nueva", () => {
    setBogotaNow("2026-09-27T05:00:00");
    expect(orderPeriodStart("today", 5)?.toISOString()).toBe("2026-09-27T10:00:00.000Z");
  });

  it("con corte 0 es la medianoche Bogotá", () => {
    setBogotaNow("2026-09-27T01:28:00");
    expect(orderPeriodStart("today", 0)?.toISOString()).toBe("2026-09-27T05:00:00.000Z");
  });

  it("7 y 30 días incluyen la jornada de hoy", () => {
    setBogotaNow("2026-09-27T01:28:00");
    expect(orderPeriodStart("7d", 5)?.toISOString()).toBe("2026-09-20T10:00:00.000Z");
    expect(orderPeriodStart("30d", 5)?.toISOString()).toBe("2026-08-28T10:00:00.000Z");
  });

  it("todo = sin filtro", () => {
    expect(orderPeriodStart("all", 5)).toBeNull();
  });
});
