import { addDaysIso } from "@/lib/bogota";
import { monthRangeUtc, weekRangeUtc } from "@/lib/erp/reports/period";

/** Six Monday-first weeks, including adjacent dates for a stable calendar. */
export function calendarDays(date: string): string[] {
  const first = weekRangeUtc(`${date.slice(0, 7)}-01`).desde;
  return Array.from({ length: 42 }, (_, index) => addDaysIso(first, index));
}

/** Preserve the day when moving months, clamping e.g. Jan 31 to Feb 28/29. */
export function shiftCalendarMonth(date: string, months: number): string {
  const first = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
  first.setUTCMonth(first.getUTCMonth() + months);
  const month = first.toISOString().slice(0, 7);
  const last = monthRangeUtc(month)!.hasta;
  return `${month}-${String(Math.min(Number(date.slice(8)), Number(last.slice(8)))).padStart(2, "0")}`;
}

/** Keyboard movement is calendar arithmetic, independent of the browser timezone. */
export function calendarKeyDate(date: string, key: string, shift: boolean, today: string): string | null {
  let next: string;
  switch (key) {
    case "ArrowLeft": next = addDaysIso(date, -1); break;
    case "ArrowRight": next = addDaysIso(date, 1); break;
    case "ArrowUp": next = addDaysIso(date, -7); break;
    case "ArrowDown": next = addDaysIso(date, 7); break;
    case "Home": next = weekRangeUtc(date).desde; break;
    case "End": next = weekRangeUtc(date).hasta; break;
    case "PageUp": next = shiftCalendarMonth(date, shift ? -12 : -1); break;
    case "PageDown": next = shiftCalendarMonth(date, shift ? 12 : 1); break;
    default: return null;
  }
  return next > today ? today : next;
}
