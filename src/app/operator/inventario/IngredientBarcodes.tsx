"use client";

import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import { BARCODE_MAX_LENGTH, ingredientBarcodeValues, normalizeBarcode, type IngredientBarcodeUpdate } from "@/lib/erp/barcode";

export function IngredientBarcodes({ ingredient, canAdd, disabled = false, suggestedCode, onSaved, onBusyChange }: {
  ingredient: IngredientBarcodeUpdate & { name: string };
  canAdd: boolean;
  disabled?: boolean;
  suggestedCode?: string | null;
  onSaved: (ingredient: IngredientBarcodeUpdate) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const t = useTranslations("opErp");
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const codes = ingredientBarcodeValues(ingredient);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy || disabled) return;
    const barcode = normalizeBarcode(value);
    if (!barcode) { setError(t("barcodeAddInvalid")); return; }
    setBusy(true); onBusyChange?.(true); setError(null); setSaved(false);
    try {
      const response = await fetch(`/api/operator/ingredients/${ingredient.id}/barcode`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ barcode }),
      });
      const result = await response.json();
      if (!response.ok) {
        const errors: Record<string, string> = {
          barcode_taken: "barcodeAddTaken", invalid: "barcodeAddInvalid",
          ingredient_inactive: "barcodeAddInactive", ingredient_not_tracked: "barcodeAddNotTracked",
          not_found: "barcodeAddUnavailable", forbidden: "barcodeAddUnavailable", unauthorized: "barcodeAddUnavailable",
          module_disabled: "barcodeAddUnavailable", operation_conflict: "barcodeAddConflict",
        };
        setError(t(errors[result.error] ?? "barcodeAddFailed"));
        return;
      }
      if (result.ingredient?.id !== ingredient.id || !Array.isArray(result.ingredient.barcodes)) throw new Error("invalid_response");
      onSaved(result.ingredient as IngredientBarcodeUpdate);
      setValue(""); setOpen(false); setSaved(true);
    } catch { setError(t("barcodeAddFailed")); }
    finally { setBusy(false); onBusyChange?.(false); }
  }

  if (!canAdd && codes.length === 0) return null;
  return (
    <div role="group" aria-label={t("barcodeGroupLabel", { name: ingredient.name })} className="mt-2 min-w-0 text-xs">
      {codes.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-op-muted">{t("barcodeCodesLabel")}</span>
          {codes.map((code) => <span key={code} className="max-w-full break-all rounded-md border border-op-border px-2 py-1 font-mono text-op-muted">{code}</span>)}
        </div>
      )}
      {canAdd && !open && (
        <button type="button" disabled={disabled} onClick={() => { setValue(suggestedCode ?? ""); setOpen(true); setError(null); setSaved(false); }}
          className="min-h-[44px] py-2 text-terracotta font-medium text-left disabled:opacity-40">
          {t(codes.length ? "barcodeAddAnother" : "barcodeAddFirst")}
        </button>
      )}
      {canAdd && open && (
        <form onSubmit={save} className="mt-2 rounded-xl border border-op-border bg-op-bg p-3 space-y-2">
          <label htmlFor={inputId} className="block text-op-muted">{t("barcodeInputLabel", { name: ingredient.name })}</label>
          <input id={inputId} type="text" value={value} maxLength={BARCODE_MAX_LENGTH} autoFocus autoComplete="off" autoCapitalize="none" spellCheck={false}
            disabled={busy || disabled} onChange={(event) => { setValue(event.target.value); setError(null); }}
            placeholder={t("barcodePlaceholder")} aria-invalid={!!error} aria-describedby={error ? `${inputId}-error` : undefined}
            className="w-full min-w-0 min-h-[44px] rounded-lg border border-op-border bg-op-surface px-3 font-mono text-sm focus:outline-none focus:border-op-text/40 disabled:opacity-50" />
          <p className="text-op-muted">{t("barcodeAddHint")}</p>
          {error && <p id={`${inputId}-error`} role="alert" className="text-danger">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={busy || disabled} className="min-h-[44px] rounded-lg bg-op-text px-3 font-medium text-op-surface disabled:opacity-40">{t(busy ? "barcodeSaving" : "barcodeSave")}</button>
            <button type="button" disabled={busy || disabled} onClick={() => { setOpen(false); setValue(""); setError(null); }} className="min-h-[44px] rounded-lg border border-op-border px-3 text-op-muted disabled:opacity-40">{t("cancel")}</button>
          </div>
        </form>
      )}
      <span role="status" className="block text-ok">{saved ? t("barcodeSaved") : ""}</span>
    </div>
  );
}
