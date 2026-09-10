"use client";

import {
  useLayoutEffect,
  useRef,
  useState,
  type InputHTMLAttributes,
} from "react";
import { useLocale } from "next-intl";
import {
  formatMoneyInput,
  moneySeparators,
  parseMoneyInput,
  parseMoneyPaste,
} from "@/lib/moneyInput";
import type { Locale } from "@/i18n/config";

type Props = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "value" | "defaultValue" | "onChange" | "type" | "inputMode"
> & {
  value: string | number;
  /** Ungrouped major units (e.g. "25000.50"), never the displayed separators. */
  onChange: (raw: string) => void;
  fractionDigits?: 0 | 2;
  allowNegative?: boolean;
  ariaLabel?: string;
};

export function MoneyInput({
  value,
  onChange,
  fractionDigits = 0,
  allowNegative = false,
  ariaLabel,
  placeholder,
  onBlur,
  onKeyDown,
  name,
  ...props
}: Props) {
  const locale = useLocale() as Locale;
  const ref = useRef<HTMLInputElement>(null);
  const cursor = useRef<number | null>(null);
  // Preserve a trailing decimal / minus even for callers that store numbers.
  const [draft, setDraft] = useState<string | null>(null);
  const sameValue =
    draft !== null &&
    (draft === String(value) ||
      (draft === "-" && (value === "" || Number(value) === 0)) ||
      (String(value) !== "" && Number(draft) === Number(value)));
  const raw = sameValue ? draft : String(value);
  const display = formatMoneyInput(raw, locale, fractionDigits);
  const { group, decimal } = moneySeparators(locale);
  useLayoutEffect(() => {
    if (cursor.current !== null && ref.current === document.activeElement)
      ref.current?.setSelectionRange(cursor.current, cursor.current);
    cursor.current = null;
  });

  function commit(text: string, position: number) {
    const next = parseMoneyInput(text, locale, fractionDigits, allowNegative);
    if (next === null) {
      if (ref.current) ref.current.value = display;
      return;
    }
    const logicalPosition = text
      .slice(0, position)
      .split(group)
      .join("").length;
    const formatted = formatMoneyInput(next, locale, fractionDigits);
    let seen = 0,
      pos = 0;
    while (pos < formatted.length && seen < logicalPosition) {
      if (formatted[pos] !== group) seen++;
      pos++;
    }
    cursor.current = pos;
    setDraft(next);
    onChange(next);
  }
  return (
    <>
      <input
        {...props}
        ref={ref}
        type="text"
        inputMode={fractionDigits ? "decimal" : "numeric"}
        value={display}
        aria-label={ariaLabel ?? props["aria-label"]}
        placeholder={
          placeholder && /^-?\d+(\.\d+)?$/.test(placeholder)
            ? formatMoneyInput(placeholder, locale, fractionDigits)
            : placeholder
        }
        onChange={(e) =>
          commit(
            e.target.value,
            e.target.selectionStart ?? e.target.value.length,
          )
        }
        onBlur={(e) => {
          const normalized = raw === "-" ? "" : raw.replace(/\.$/, "");
          if (normalized !== raw) onChange(normalized);
          setDraft(null);
          onBlur?.(e);
        }}
        onPaste={(e) => {
          const pasted = parseMoneyPaste(
            e.clipboardData.getData("text"),
            locale,
            fractionDigits,
            allowNegative,
          );
          e.preventDefault();
          if (pasted === null) return;
          const input = e.currentTarget,
            start = input.selectionStart ?? 0,
            end = input.selectionEnd ?? start;
          const insert = formatMoneyInput(pasted, locale, fractionDigits);
          commit(
            display.slice(0, start) + insert + display.slice(end),
            start + insert.length,
          );
        }}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
          const start = e.currentTarget.selectionStart ?? 0,
            end = e.currentTarget.selectionEnd ?? start;
          if (e.key === group) {
            e.preventDefault(); // grouping is automatic; typing a dot/comma must not change the amount
          } else if (fractionDigits && e.key === decimal) {
            e.preventDefault();
            commit(
              display.slice(0, start) + decimal + display.slice(end),
              start + 1,
            );
          } else if (
            start === end &&
            e.key === "Backspace" &&
            display[start - 1] === group
          ) {
            e.preventDefault();
            commit(
              display.slice(0, Math.max(0, start - 2)) + display.slice(start),
              Math.max(0, start - 2),
            );
          } else if (
            start === end &&
            e.key === "Delete" &&
            display[start] === group
          ) {
            e.preventDefault();
            commit(display.slice(0, start) + display.slice(start + 2), start);
          }
        }}
      />
      {name && (
        <input
          type="hidden"
          name={name}
          value={value}
          disabled={props.disabled}
        />
      )}
    </>
  );
}
