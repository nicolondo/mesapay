"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { AppDialog } from "@/components/ui/AppDialog";
import type { Locale } from "@/i18n/config";
import { formatDate } from "@/lib/format";
import { addDaysIso } from "@/lib/bogota";
import { isIsoDate } from "@/lib/erp/reports/period";
import { monthLabel } from "@/lib/erp/reports/periodLabel";
import { calendarDays, calendarKeyDate, shiftCalendarMonth } from "@/lib/orders/dayCalendar";

/** One date, never an interval. Mounted only while the chooser is open. */
export function OrdersDayPicker({ selectedDate, today, onSelect, onClose }: {
  selectedDate: string;
  today: string;
  onSelect: (day: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations("opOrders");
  const locale = useLocale() as Locale;
  const initial = selectedDate > today ? today : selectedDate;
  const [focusedDay, setFocusedDay] = useState(initial);
  const [inputDate, setInputDate] = useState(initial);
  const focusedButton = useRef<HTMLButtonElement>(null);
  const moveFocus = useRef(false);
  const headingId = useId();
  const helpId = useId();
  const inputId = useId();
  const month = focusedDay.slice(0, 7);
  const days = calendarDays(focusedDay);
  const monthTitle = monthLabel(focusedDay, locale);

  useEffect(() => {
    const dialog = focusedButton.current?.closest("dialog");
    if (!dialog) return;
    // Centered dialogs measure their height while hidden. Focus only once that
    // first measurement is visible, rather than letting it land behind the modal.
    const focusWhenVisible = () => {
      const button = focusedButton.current;
      if (!dialog.open || !button || getComputedStyle(button).visibility !== "visible") return;
      button.focus({ preventScroll: true });
      observer.disconnect();
    };
    const observer = new MutationObserver(focusWhenVisible);
    observer.observe(dialog, { attributes: true, attributeFilter: ["open", "style"] });
    focusWhenVisible();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    focusedButton.current?.focus({ preventScroll: true });
  }, [focusedDay]);

  const dateLabel = (day: string, options: Intl.DateTimeFormatOptions) => formatDate(`${day}T00:00:00Z`, {
    locale, timeZone: "UTC", dateStyle: undefined, timeStyle: undefined, ...options,
  });

  function focusDay(day: string) {
    moveFocus.current = day !== focusedDay;
    if (!moveFocus.current) focusedButton.current?.focus({ preventScroll: true });
    setFocusedDay(day);
    setInputDate(day);
  }

  function onDayKey(event: KeyboardEvent<HTMLButtonElement>, day: string) {
    const next = calendarKeyDate(day, event.key, event.shiftKey, today);
    if (next === null) return;
    event.preventDefault();
    focusDay(next);
  }

  function changeMonth(direction: -1 | 1) {
    const next = shiftCalendarMonth(focusedDay, direction);
    // Keep focus on the month control unless it becomes disabled at today.
    moveFocus.current = direction === 1 && next.slice(0, 7) === today.slice(0, 7);
    setFocusedDay(next > today ? today : next);
    setInputDate(next > today ? today : next);
  }

  function choose(day: string) {
    if (isIsoDate(day) && day <= today) onSelect(day);
  }

  return (
    <AppDialog label={t("dayPickerTitle")} onClose={onClose} placement="center" className="rounded-2xl border border-op-border bg-op-surface text-op-text shadow-xl">
      <div className="p-4 sm:p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="font-display text-2xl">{t("dayPickerTitle")}</h2>
        <button type="button" onClick={onClose} aria-label={t("dayPickerClose")} className="mp-icobtn shrink-0">
          {"×"}
        </button>
      </div>
      <div className="mb-3 grid grid-cols-[auto_1fr_auto] items-center gap-2">
        <button type="button" onClick={event => { event.currentTarget.focus({ preventScroll: true }); changeMonth(-1); }} aria-label={t("prevMonth")} className="mp-icobtn">
          {"←"}
        </button>
        <h3 id={headingId} aria-live="polite" className="min-w-0 text-center text-sm font-semibold">{monthTitle}</h3>
        <button type="button" onClick={event => { event.currentTarget.focus({ preventScroll: true }); changeMonth(1); }} disabled={month >= today.slice(0, 7)} aria-label={t("nextMonth")} className="mp-icobtn disabled:opacity-35">
          {"→"}
        </button>
      </div>
      <p id={helpId} className="sr-only">{t("dayPickerHelp")}</p>
      <table role="grid" aria-labelledby={headingId} aria-describedby={helpId} className="w-full table-fixed border-separate border-spacing-0.5 text-center text-sm">
        <thead>
          <tr>
            {Array.from({ length: 7 }, (_, index) => {
              const day = addDaysIso("2024-01-01", index);
              return <th key={index} scope="col" aria-label={dateLabel(day, { weekday: "long" })} className="pb-2 text-xs font-normal text-op-muted">{dateLabel(day, { weekday: "short" })}</th>;
            })}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 6 }, (_, week) => (
            <tr key={week}>
              {days.slice(week * 7, week * 7 + 7).map(day => {
                const selected = day === selectedDate;
                const focused = day === focusedDay;
                return (
                  <td key={day} aria-selected={selected}>
                    <button
                      type="button"
                      ref={focused ? focusedButton : undefined}
                      tabIndex={focused ? 0 : -1}
                      disabled={day > today}
                      aria-label={dateLabel(day, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
                      aria-current={day === today ? "date" : undefined}
                      onClick={() => choose(day)}
                      onKeyDown={event => onDayKey(event, day)}
                      className={`h-11 w-full rounded-lg transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-terracotta disabled:cursor-not-allowed disabled:opacity-30 ${selected ? "bg-op-text text-op-surface" : day.slice(0, 7) !== month ? "text-op-muted hover:bg-op-bg" : "text-op-text hover:bg-op-bg"} ${day === today && !selected ? "font-semibold ring-1 ring-inset ring-op-border" : ""}`}
                    >
                      {Number(day.slice(8))}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <form className="mt-4 grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2 border-t border-op-border pt-4" onSubmit={event => { event.preventDefault(); choose(inputDate); }}>
        <label htmlFor={inputId} className="min-w-0">
          <span className="mb-1 block text-xs text-op-muted">{t("dayPickerDate")}</span>
          <input id={inputId} type="date" value={inputDate} max={today} required className="h-11 w-full min-w-0 rounded-lg border border-op-border bg-op-bg px-2 text-sm" onChange={event => {
            const next = event.target.value;
            moveFocus.current = false;
            setInputDate(next);
            if (isIsoDate(next) && next <= today) setFocusedDay(next);
          }} />
        </label>
        <button type="submit" className="mp-btn mp-btn--primary mp-btn--sm h-11">{t("dayPickerApply")}</button>
      </form>
      </div>
    </AppDialog>
  );
}
