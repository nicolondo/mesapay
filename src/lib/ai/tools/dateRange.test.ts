import { describe, it, expect } from "vitest";
import { resolveRange, timezoneForCountry, rangeInputZod } from "./dateRange";

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

describe("rangeInputZod", () => {
  it("default es preset 30d", () => {
    expect(rangeInputZod.parse(undefined)).toEqual({ preset: "30d" });
  });
  it("acepta from/to", () => {
    expect(rangeInputZod.parse({ from: "2026-01-01", to: "2026-02-01" })).toEqual({
      from: "2026-01-01",
      to: "2026-02-01",
    });
  });
  it("acepta range como STRING JSON (lo que manda Claude en la práctica)", () => {
    expect(rangeInputZod.parse('{"preset":"mtd"}')).toEqual({ preset: "mtd" });
    expect(rangeInputZod.parse('{"from":"2026-06-01","to":"2026-06-09"}')).toEqual({
      from: "2026-06-01",
      to: "2026-06-09",
    });
  });
  it("tolera string JSON con espacios/newlines", () => {
    expect(rangeInputZod.parse('\n{\n  "preset": "mtd"\n}\n')).toEqual({ preset: "mtd" });
  });
});
