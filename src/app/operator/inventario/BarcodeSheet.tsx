"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { AppDialog } from "@/components/ui/AppDialog";
import { BARCODE_MAX_LENGTH, ingredientBarcodeValues, normalizeBarcode, type IngredientBarcodeUpdate } from "@/lib/erp/barcode";
import { addIngredientBarcode, removeIngredientBarcode } from "./barcodeApi";
import { InvIcon } from "./InventoryIcons";
import type { StockRow } from "./types";

/**
 * «Códigos de barras» de un insumo (desde el menú ⋯ o el chip ▥ de la fila):
 * lista los códigos con el principal marcado, agrega uno nuevo (el lector
 * HID escribe y manda Enter → guarda) y quita los que sobran. Las reglas son
 * las del server (#399): normalización, unicidad por comercio y alta solo
 * en insumos activos; quitar se permite también en archivados para poder
 * liberar el código.
 */
export function BarcodeSheet({ ingredient, onClose, onSaved }: {
  ingredient: StockRow;
  onClose: () => void;
  onSaved: (ingredient: IngredientBarcodeUpdate) => void;
}) {
  const t = useTranslations("opErp");
  const inputId = useId();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const codes = ingredientBarcodeValues(ingredient);
  const canAdd = ingredient.active;

  // Con mouse y teclado (o lector HID) el campo queda listo para escanear.
  // En pantallas táctiles no: el teclado taparía la lista de códigos. Se
  // espera un cuadro para que el <dialog> ya esté abierto (showModal).
  useEffect(() => {
    if (!canAdd || !window.matchMedia("(pointer: fine)").matches) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [canAdd]);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!normalizeBarcode(value)) { setError(t("barcodeAddInvalid")); return; }
    setBusy("add"); setError(null); setStatus(null);
    const result = await addIngredientBarcode(ingredient.id, value);
    setBusy(null);
    if (!result.ok) { setError(t(result.errorKey, result.errorValues)); return; }
    onSaved(result.ingredient);
    setValue("");
    setStatus(t("barcodeSaved"));
  }

  async function remove(code: string) {
    if (busy) return;
    if (!window.confirm(t("barcodeRemoveConfirm", { code, name: ingredient.name }))) return;
    setBusy(code); setError(null); setStatus(null);
    const result = await removeIngredientBarcode(ingredient.id, code);
    setBusy(null);
    if (!result.ok) { setError(t(result.errorKey, result.errorValues)); return; }
    onSaved(result.ingredient);
    setStatus(t("barcodeRemoved"));
  }

  return (
    <AppDialog label={t("barcodeSheetTitle")} onClose={() => { if (!busy) onClose(); }} className="mp-sheet mp-sheet--md-center">
      <div className="flex max-h-[85dvh] flex-col">
        <div className="flex items-start justify-between gap-3 border-b border-op-border py-4 pl-5 pr-3">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold tracking-tight">{t("barcodeSheetTitle")}</h2>
            <p className="mt-0.5 truncate text-sm text-op-muted">{ingredient.name}</p>
          </div>
          <button type="button" onClick={onClose} disabled={!!busy} aria-label={t("closeSheet")} className="mp-icon-button shrink-0">
            <InvIcon name="close" size={20} />
          </button>
        </div>

        <div role="group" aria-label={t("barcodeGroupLabel", { name: ingredient.name })} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
          <p className="text-sm text-op-muted">{t("barcodeSheetIntro")}</p>

          {codes.length === 0 ? (
            <p className="mt-4 rounded-xl border border-dashed border-op-border px-4 py-5 text-center text-sm text-op-muted">{t("barcodeNone")}</p>
          ) : (
            <ul className="mt-4 divide-y divide-op-border rounded-xl border border-op-border">
              {codes.map((code) => (
                <li key={code} className="flex min-h-[52px] items-center gap-3 px-3 py-1.5">
                  <InvIcon name="barcode" className="shrink-0 text-op-muted" />
                  <span className="min-w-0 flex-1 break-all font-mono text-sm">{code}</span>
                  {code === ingredient.barcode && <span className="mp-inv-pill shrink-0">{t("barcodePrimaryBadge")}</span>}
                  <button
                    type="button"
                    onClick={() => remove(code)}
                    disabled={!!busy}
                    aria-label={t("barcodeRemoveNamed", { code })}
                    className="mp-btn mp-btn--ghost mp-btn--sm mp-inv-remove shrink-0"
                  >
                    {busy === code ? t("saving") : t("barcodeRemove")}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {canAdd ? (
            <form onSubmit={add} className="mt-5 space-y-2">
              <label htmlFor={inputId} className="block text-sm font-medium">
                {t(codes.length ? "barcodeAddAnother" : "barcodeAddFirst")}
              </label>
              <div className="flex gap-2">
                <input
                  ref={inputRef}
                  id={inputId}
                  type="text"
                  value={value}
                  maxLength={BARCODE_MAX_LENGTH}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  enterKeyHint="done"
                  aria-label={t("barcodeInputLabel", { name: ingredient.name })}
                  disabled={!!busy}
                  onChange={(event) => { setValue(event.target.value); setError(null); setStatus(null); }}
                  placeholder={t("barcodePlaceholder")}
                  aria-invalid={!!error}
                  aria-describedby={`${inputId}-hint${error ? ` ${inputId}-error` : ""}`}
                  className="min-h-[44px] w-full min-w-0 flex-1 rounded-lg border border-op-border-2 bg-op-surface px-3 font-mono text-sm focus:border-op-text/40 focus:outline-none disabled:opacity-50"
                />
                <button type="submit" disabled={!!busy || !value.trim()} className="mp-btn mp-btn--primary shrink-0">
                  {t(busy === "add" ? "barcodeSaving" : "barcodeSave")}
                </button>
              </div>
              <p id={`${inputId}-hint`} className="text-xs text-op-muted">{t("barcodeAddHint")}</p>
            </form>
          ) : (
            <p className="mt-5 text-sm text-op-muted">{t("barcodeAddInactive")}</p>
          )}

          {error && <p id={`${inputId}-error`} role="alert" className="mt-3 text-sm text-danger">{error}</p>}
          <p role="status" className="mt-2 min-h-[1.25rem] text-sm text-ok">{status ?? ""}</p>
        </div>
      </div>
    </AppDialog>
  );
}
