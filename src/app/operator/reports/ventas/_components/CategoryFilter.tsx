"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

type Choice = { value: string; label: string; parentId: string | null };

export function CategoryFilter({ choices, selected, onApply }: {
  choices: Choice[];
  selected: string[];
  onApply: (ids: string[]) => void;
}) {
  const t = useTranslations("salesAnalysis");
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(selected);
  const field = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !field.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  function close() {
    setOpen(false);
    trigger.current?.focus();
  }
  function toggle(choice: Choice) {
    setDraft((ids) => {
      if (ids.includes(choice.value)) return ids.filter((id) => id !== choice.value);
      // Sus hijas pasan a estar incluidas por el padre.
      const children = new Set(choices.filter((c) => c.parentId === choice.value).map((c) => c.value));
      return [...ids.filter((id) => !children.has(id)), choice.value];
    });
  }
  const summary = selected.length > 1 ? t("categoryCount", { count: selected.length })
    : choices.find((c) => c.value === selected[0])?.label ?? t("allCategories");

  return (
    <div className="mp-sales-field relative" ref={field}
      onBlur={(e) => { if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) setOpen(false); }}
      onKeyDown={(e) => { if (open && e.key === "Escape") { e.preventDefault(); close(); } }}>
      <span id="sales-category-label">{t("dim.categoria")}</span>
      <button type="button" ref={trigger} aria-expanded={open} aria-controls="sales-category-options"
        aria-labelledby="sales-category-label sales-category-summary"
        className="flex h-10 items-center justify-between gap-2 rounded-xl border border-op-border bg-op-surface px-3 text-sm text-op-text"
        onClick={() => { setDraft(selected); setOpen(!open); }}>
        <span id="sales-category-summary" className="truncate">{summary}</span>
        <span aria-hidden="true" className="size-2 shrink-0 -translate-y-0.5 rotate-45 border-b border-r" />
      </button>
      {open && (
        <div id="sales-category-options" role="group" tabIndex={-1} aria-labelledby="sales-category-label"
          className="absolute left-0 top-full z-30 mt-1 w-full min-w-0 rounded-xl border border-op-border bg-op-surface p-2 text-sm text-op-text shadow-lg sm:min-w-64">
          <div className="max-h-[min(40dvh,22rem)] overflow-y-auto overscroll-contain">
            <label className="flex min-h-10 items-center gap-2 px-2">
              <input type="checkbox" checked={!draft.length} onChange={() => setDraft([])} />
              {t("allCategories")}
            </label>
            {choices.map((c) => {
              const inherited = c.parentId !== null && draft.includes(c.parentId);
              return (
                <label key={c.value} className={`flex min-h-10 items-center gap-2 px-2 ${inherited ? "text-op-muted" : ""}`}>
                  <input type="checkbox" checked={inherited || draft.includes(c.value)} disabled={inherited}
                    onChange={() => toggle(c)} />
                  {c.label}
                </label>
              );
            })}
          </div>
          <div className="flex justify-between gap-2 border-t border-op-border pt-2">
            <button type="button" className="mp-btn mp-btn--secondary" onClick={() => setDraft([])}>{t("clearCategories")}</button>
            <button type="button" className="mp-btn mp-btn--primary" onClick={() => { close(); onApply(draft); }}>{t("apply")}</button>
          </div>
        </div>
      )}
    </div>
  );
}
