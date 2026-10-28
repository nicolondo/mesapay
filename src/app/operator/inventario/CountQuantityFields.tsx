"use client";

import { useTranslations } from "next-intl";
import { sanitizeDecimalInput } from "@/lib/decimalInput";
import { parseCountEntry, type CountEntry } from "@/lib/erp/stockCountInput";
import { MAX_COUNT_PARTS } from "@/lib/erp/stockCountParts";
import { DISPLAY_UNITS, type MeasureKind } from "@/lib/erp/units";

type Props = {
  itemId: string;
  name: string;
  kind: MeasureKind;
  entries: CountEntry[];
  disabled: boolean;
  tracked: boolean;
  invalidTotal: boolean;
  errorKey: string | null;
  setInputRef: (index: number, element: HTMLInputElement | null) => void;
  onChange: (index: number, change: Partial<CountEntry>) => void;
  onEnter: (index: number) => void;
  onRemove: (index: number) => void;
  onAdd: () => void;
};

export function CountQuantityFields({ itemId, name, kind, entries, disabled, tracked, invalidTotal, errorKey, setInputRef, onChange, onEnter, onRemove, onAdd }: Props) {
  const t = useTranslations("opErp");
  const units = DISPLAY_UNITS[kind];
  return (
    <div className="mt-3">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,9rem),1fr))] gap-x-3 gap-y-2">
        {entries.map((entry, index) => {
          const key = `${itemId}:${index}`;
          const value = parseCountEntry(entry.raw, kind, entry.unit);
          const invalid = value === "invalid" || (errorKey === key && (value === null || invalidTotal));
          const hintId = `count-quantity-${itemId}-${index}-hint`;
          return (
            <div key={key} className="min-w-0">
              <div className="flex min-h-[44px] items-center justify-between gap-1">
                <span className="text-xs font-medium text-op-muted">{t("countPartNumber", { number: index + 1 })}</span>
                {entries.length > 1 && (
                  <button type="button" disabled={disabled} onClick={() => onRemove(index)}
                    aria-label={t("countRemovePartLabel", { number: index + 1, name })}
                    className="min-h-[44px] min-w-[44px] text-op-muted hover:text-danger disabled:opacity-40">
                    {"×"}
                  </button>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <input ref={(element) => setInputRef(index, element)} type="text" inputMode="decimal" enterKeyHint="next"
                  aria-label={index === 0 ? t("countQuantityLabel", { name }) : t("countPartQuantityLabel", { number: index + 1, name })}
                  aria-describedby={tracked ? hintId : undefined} aria-invalid={invalid}
                  disabled={disabled} value={entry.raw} placeholder={t("notCounted")}
                  onChange={(event) => onChange(index, { raw: sanitizeDecimalInput(event.target.value) })}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                    event.preventDefault();
                    onEnter(index);
                  }}
                  className="w-full min-w-0 flex-1 min-h-[44px] px-3 rounded-xl border border-op-border bg-op-bg text-sm tabular-nums focus:outline-none focus:border-op-text/40 disabled:opacity-40"
                />
                <select value={entry.unit}
                  aria-label={index === 0 ? t("countUnitLabel", { name }) : t("countPartUnitLabel", { number: index + 1, name })}
                  onChange={(event) => onChange(index, { unit: event.target.value })}
                  disabled={disabled || units.length < 2}
                  className="min-h-[44px] w-16 shrink-0 px-1 rounded-lg border border-op-border bg-op-bg text-sm disabled:opacity-40">
                  {units.map(unit => <option key={unit.symbol} value={unit.symbol}>{unit.symbol}</option>)}
                </select>
              </div>
              {tracked && (
                <p id={hintId} role={invalid ? "alert" : undefined} className={"mt-1.5 text-xs leading-relaxed " + (invalid ? "text-danger" : "text-op-muted")}>
                  {t(invalid ? (value !== "invalid" && value !== null && invalidTotal ? "countPartsInvalidTotal" : "countQuantityEnterError") : "countQuantityEnterHint")}
                </p>
              )}
            </div>
          );
        })}
      </div>
      {tracked && (
        <button type="button" onClick={onAdd} disabled={disabled || entries.length >= MAX_COUNT_PARTS}
          className="min-h-[44px] text-sm text-terracotta disabled:opacity-40">
          {t("countAddPart")}
        </button>
      )}
    </div>
  );
}
