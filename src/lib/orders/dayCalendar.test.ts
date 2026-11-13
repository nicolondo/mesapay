import { describe, expect, it } from "vitest";
import { calendarDays, calendarKeyDate, shiftCalendarMonth } from "./dayCalendar";

describe("order day calendar", () => {
  it("aligns weeks Monday to Sunday across month and year boundaries", () => {
    const days = calendarDays("2026-11-01");
    expect(days).toHaveLength(42);
    expect(days[0]).toBe("2026-10-26");
    expect(days[6]).toBe("2026-11-01");
    expect(days.at(-1)).toBe("2026-12-06");
    expect(new Set(days).size).toBe(42);
    expect(calendarDays("2027-01-01")[0]).toBe("2026-12-28");
  });

  it("keeps the day when changing month and clamps leap days to real dates", () => {
    expect(shiftCalendarMonth("2024-01-31", 1)).toBe("2024-02-29");
    expect(shiftCalendarMonth("2026-03-31", -1)).toBe("2026-02-28");
    expect(shiftCalendarMonth("2024-02-29", 12)).toBe("2025-02-28");
    expect(shiftCalendarMonth("2026-12-15", 1)).toBe("2027-01-15");
  });

  it("navigates dates with keyboard, including week edges and whole years", () => {
    const today = "2027-12-31";
    expect(calendarKeyDate("2026-10-31", "ArrowRight", false, today)).toBe("2026-11-01");
    expect(calendarKeyDate("2026-11-01", "ArrowLeft", false, today)).toBe("2026-10-31");
    expect(calendarKeyDate("2026-11-01", "ArrowUp", false, today)).toBe("2026-10-25");
    expect(calendarKeyDate("2026-10-31", "ArrowDown", false, today)).toBe("2026-11-07");
    expect(calendarKeyDate("2026-11-01", "Home", false, today)).toBe("2026-10-26");
    expect(calendarKeyDate("2026-10-31", "End", false, today)).toBe("2026-11-01");
    expect(calendarKeyDate("2026-10-31", "PageUp", false, today)).toBe("2026-09-30");
    expect(calendarKeyDate("2026-10-31", "PageDown", false, today)).toBe("2026-11-30");
    expect(calendarKeyDate("2024-02-29", "PageDown", true, today)).toBe("2025-02-28");
    expect(calendarKeyDate("2026-10-31", "PageUp", true, today)).toBe("2025-10-31");
    expect(calendarKeyDate("2026-10-31", "Enter", false, today)).toBeNull();
  });

  it("never moves focus beyond the restaurant's current business day", () => {
    expect(calendarKeyDate("2026-11-01", "ArrowRight", false, "2026-11-01")).toBe("2026-11-01");
    expect(calendarKeyDate("2026-10-31", "PageDown", false, "2026-11-08")).toBe("2026-11-08");
    expect(calendarKeyDate("2026-11-04", "End", false, "2026-11-05")).toBe("2026-11-05");
  });
});
