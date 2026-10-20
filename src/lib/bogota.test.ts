import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bogotaBusinessDateIso,
  bogotaBusinessTodayIso,
  bogotaDayRange,
  shiftBusinessDateIso,
} from "./bogota";

afterEach(() => vi.useRealTimers());

describe("business dates in Bogotá", () => {
  it.each([
    [0, "2026-10-18T04:59:59.999Z", "2026-10-17"],
    [0, "2026-10-18T05:00:00.000Z", "2026-10-18"],
    [0, "2026-10-18T05:00:00.001Z", "2026-10-18"],
    [5, "2026-10-18T09:59:59.999Z", "2026-10-17"],
    [5, "2026-10-18T10:00:00.000Z", "2026-10-18"],
    [5, "2026-10-18T10:00:00.001Z", "2026-10-18"],
    [23, "2026-10-19T03:59:59.999Z", "2026-10-17"],
    [23, "2026-10-19T04:00:00.000Z", "2026-10-18"],
    [23, "2026-10-19T04:00:00.001Z", "2026-10-18"],
  ])("uses cutoff %i for %s without server-time-zone dependence", (cutoff, instant, expected) => {
    const at = new Date(instant);
    expect(bogotaBusinessDateIso(at, cutoff)).toBe(expected);
    const { start, end } = bogotaDayRange(expected, cutoff);
    expect(at.getTime()).toBeGreaterThanOrEqual(start.getTime());
    expect(at.getTime()).toBeLessThan(end.getTime());
  });

  it.each([
    ["2026-11-01T06:18:00.000Z", "2026-10-31"],
    ["2027-01-01T06:18:00.000Z", "2026-12-31"],
    ["2024-03-01T06:18:00.000Z", "2024-02-29"],
    ["2026-03-01T06:18:00.000Z", "2026-02-28"],
  ])("handles calendar boundaries at %s", (instant, expected) => {
    expect(bogotaBusinessDateIso(new Date(instant), 5)).toBe(expected);
  });

  it("uses local midnight when no cutoff is supplied", () => {
    expect(bogotaBusinessDateIso(new Date("2026-10-18T06:18:00Z"))).toBe("2026-10-18");
  });

  it("keeps today's business-date helper consistent with arbitrary instants", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-18T06:18:00Z"));
    expect(bogotaBusinessTodayIso(5)).toBe("2026-10-17");
    expect(bogotaBusinessTodayIso()).toBe("2026-10-18");
  });
});

describe("shift business dates", () => {
  it.each([
    ["2026-10-17T17:10:00Z", "2026-10-17"],
    ["2026-10-11T16:07:00Z", "2026-10-11"],
    ["2026-10-18T06:00:00Z", "2026-10-17"],
  ])("derives a legacy shift's date from its opening at %s", (instant, expected) => {
    expect(shiftBusinessDateIso({ openedAt: new Date(instant) }, 5)).toBe(expected);
    expect(shiftBusinessDateIso({ businessDate: null, openedAt: new Date(instant) }, 5)).toBe(expected);
  });

  it("reads a stored DATE in UTC and preserves it after cutoff changes", () => {
    const shift = {
      businessDate: new Date("2026-10-17T00:00:00Z"),
      openedAt: new Date("2026-10-18T06:00:00Z"),
    };
    expect(shiftBusinessDateIso(shift, 0)).toBe("2026-10-17");
    expect(shiftBusinessDateIso(shift, 23)).toBe("2026-10-17");
  });

  it("keeps the opening's business date for a shift closed more than a day later", () => {
    const shift = {
      openedAt: new Date("2026-10-17T17:10:00Z"),
      closedAt: new Date("2026-10-19T11:18:00Z"),
    };
    expect(shiftBusinessDateIso(shift, 5)).toBe("2026-10-17");
  });
});
