import { describe, it, expect } from "vitest";
import { resolveRange, timezoneForCountry } from "./dateRange";

describe("timezoneForCountry", () => {
  it("mapea CO y MX, default Bogota", () => {
    expect(timezoneForCountry("CO")).toBe("America/Bogota");
    expect(timezoneForCountry("MX")).toBe("America/Mexico_City");
    expect(timezoneForCountry(null)).toBe("America/Bogota");
  });
});

describe("resolveRange", () => {
  it("preset 30d devuelve from <= to y ~30 días", () => {
    const now = new Date("2026-06-08T12:00:00Z");
    const r = resolveRange({ preset: "30d" }, now);
    const days = (r.to.getTime() - r.from.getTime()) / 86400000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);
    expect(r.from.getTime()).toBeLessThanOrEqual(r.to.getTime());
  });
  it("clampea rangos > 13 meses", () => {
    const now = new Date("2026-06-08T12:00:00Z");
    const r = resolveRange({ from: "2000-01-01", to: "2026-06-08" }, now);
    const days = (r.to.getTime() - r.from.getTime()) / 86400000;
    expect(days).toBeLessThanOrEqual(400);
  });
});
