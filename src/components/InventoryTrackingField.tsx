"use client";

import { useId } from "react";
import { useTranslations } from "next-intl";

export function InventoryTrackingField({ checked, onChange, kind, disabled = false }: {
  checked: boolean;
  onChange: (value: boolean) => void;
  kind: "ingredient" | "product";
  disabled?: boolean;
}) {
  const t = useTranslations("inventoryTracking");
  const hintId = useId();
  return (
    <div className="rounded-xl border border-op-border p-3 space-y-1">
      <label className="flex items-center gap-3 min-h-[44px] cursor-pointer text-sm font-medium">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} disabled={disabled} aria-describedby={hintId} className="h-5 w-5 shrink-0 accent-terracotta" />
        {t("label")}
      </label>
      <p id={hintId} className="text-xs text-op-muted leading-relaxed">
        {t(kind === "ingredient" ? "ingredientHint" : "productHint")}
      </p>
      {!checked && <p className="text-xs font-medium text-op-text">{t("untracked")}</p>}
    </div>
  );
}
