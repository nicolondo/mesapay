"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { AppDialog } from "@/components/ui/AppDialog";
import { BARCODE_MAX_LENGTH, ingredientBarcodeValues, normalizeBarcode, type IngredientBarcodeUpdate } from "@/lib/erp/barcode";
import { ingredientMatchesSearch, type SearchableIngredient } from "@/lib/erp/ingredientSearch";
import {
  addIngredientBarcode, moveIngredientBarcode, removeIngredientBarcode, replaceIngredientBarcode,
  type BarcodeFailure, type BarcodeOwnerRef,
} from "./barcodeApi";
import { InvIcon } from "./InventoryIcons";

export type BarcodeSheetIngredient = IngredientBarcodeUpdate & { name: string; active: boolean };
/** Insumo al que se le puede pasar un código (activo y con inventario). */
export type BarcodeMoveTarget = SearchableIngredient & { id: string };

/**
 * «Códigos de barras» de un insumo (menú ⋯ o chip ▥ de Existencias, y el
 * botón ▥ de cada fila del conteo): lista los códigos con el principal
 * marcado y permite agregar uno (el lector HID escribe y manda Enter →
 * guarda), EDITAR su valor cuando se digitó o escaneó mal, PASARLO a otro
 * insumo cuando se guardó en el que no era, y quitarlo. Si el código que se
 * quiere agregar ya lo tiene otro insumo, dice cuál y ofrece pasárselo a
 * este en un paso. Las reglas son las del server (#399): normalización,
 * unicidad por comercio y alta solo en insumos activos; quitar o soltar se
 * permite también en archivados para poder liberar el código.
 */
export function BarcodeSheet({ ingredient, onClose, onSaved, onMoved, moveTargets, suggestedCode }: {
  ingredient: BarcodeSheetIngredient;
  onClose: () => void;
  onSaved: (ingredient: IngredientBarcodeUpdate) => void;
  /** Un código cambió de insumo: llegan los dos registros (origen y destino). */
  onMoved?: (source: IngredientBarcodeUpdate, target: IngredientBarcodeUpdate) => void;
  moveTargets?: readonly BarcodeMoveTarget[];
  /** Código recién escaneado que no era de nadie: llega escrito en el campo. */
  suggestedCode?: string | null;
}) {
  const t = useTranslations("opErp");
  const inputId = useId();
  const [value, setValue] = useState(suggestedCode ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  /** Código ocupado por otro insumo: se ofrece pasárselo a este. */
  const [taken, setTaken] = useState<{ code: string; owner: BarcodeOwnerRef } | null>(null);
  const [editing, setEditing] = useState<{ code: string; value: string } | null>(null);
  const [moving, setMoving] = useState<{ code: string; q: string } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const codes = ingredientBarcodeValues(ingredient);
  const canAdd = ingredient.active;
  const targets = useMemo(
    () => (moveTargets ?? []).filter((target) => target.id !== ingredient.id),
    [moveTargets, ingredient.id],
  );
  const matches = useMemo(
    () => (moving ? targets.filter((target) => ingredientMatchesSearch(target, moving.q)).slice(0, 40) : []),
    [targets, moving],
  );

  // Con mouse y teclado (o lector HID) el campo queda listo para escanear.
  // En pantallas táctiles no: el teclado taparía la lista de códigos. Se
  // espera un cuadro para que el <dialog> ya esté abierto (showModal).
  useEffect(() => {
    if (!canAdd || !window.matchMedia("(pointer: fine)").matches) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [canAdd]);

  function reset() { setError(null); setStatus(null); setTaken(null); }
  function fail(result: BarcodeFailure, code?: string) {
    // Con el dueño a la vista se ofrece el traspaso en vez de mandar a buscarlo.
    if (result.owner && code && canAdd && result.owner.id !== ingredient.id) {
      setTaken({ code, owner: result.owner });
      setError(t(result.owner.active ? "barcodeTakenByOffer" : "barcodeTakenByArchivedOffer", { name: result.owner.name }));
      return;
    }
    setError(t(result.errorKey, result.errorValues));
  }

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const code = normalizeBarcode(value);
    if (!code) { reset(); setError(t("barcodeAddInvalid")); return; }
    setBusy("add"); reset();
    const result = await addIngredientBarcode(ingredient.id, code);
    setBusy(null);
    if (!result.ok) { fail(result, code); return; }
    onSaved(result.ingredient);
    setValue("");
    setStatus(t("barcodeSaved"));
  }

  /** «Pasárselo a este insumo»: lo suelta quien lo tiene y queda aquí. */
  async function take() {
    if (busy || !taken) return;
    const { code, owner } = taken;
    if (!window.confirm(t("barcodeTakeConfirm", { code, owner: owner.name, name: ingredient.name }))) return;
    setBusy("take"); setError(null); setStatus(null);
    const result = await moveIngredientBarcode(owner.id, code, ingredient.id);
    setBusy(null);
    if (!result.ok) { setTaken(null); setError(t(result.errorKey, result.errorValues)); return; }
    setTaken(null);
    onSaved(result.target);
    onMoved?.(result.ingredient, result.target);
    setValue("");
    setStatus(t("barcodeTaken", { owner: owner.name }));
  }

  async function saveEdit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !editing) return;
    const next = normalizeBarcode(editing.value);
    if (!next) { reset(); setError(t("barcodeAddInvalid")); return; }
    if (next === editing.code) { setEditing(null); return; }
    setBusy(editing.code); reset();
    const result = await replaceIngredientBarcode(ingredient.id, editing.code, next);
    setBusy(null);
    if (!result.ok) { setError(t(result.errorKey, result.errorValues)); return; }
    onSaved(result.ingredient);
    setEditing(null);
    setStatus(t("barcodeEdited"));
  }

  async function moveTo(target: BarcodeMoveTarget) {
    if (busy || !moving) return;
    const { code } = moving;
    if (!window.confirm(t("barcodeMoveConfirm", { code, name: ingredient.name, target: target.name }))) return;
    setBusy(code); reset();
    const result = await moveIngredientBarcode(ingredient.id, code, target.id);
    setBusy(null);
    if (!result.ok) { setError(t(result.errorKey, result.errorValues)); return; }
    onSaved(result.ingredient);
    onMoved?.(result.ingredient, result.target);
    setMoving(null);
    setStatus(t("barcodeMoved", { target: target.name }));
  }

  async function remove(code: string) {
    if (busy) return;
    if (!window.confirm(t("barcodeRemoveConfirm", { code, name: ingredient.name }))) return;
    setBusy(code); reset();
    const result = await removeIngredientBarcode(ingredient.id, code);
    setBusy(null);
    if (!result.ok) { setError(t(result.errorKey, result.errorValues)); return; }
    onSaved(result.ingredient);
    setStatus(t("barcodeRemoved"));
  }

  return (
    <AppDialog label={t("barcodeSheetTitle")} onClose={() => { if (!busy) onClose(); }} dismissOnBackdrop={false} className="mp-sheet mp-sheet--md-center">
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
                <li key={code} className="px-3 py-1.5">
                  {editing?.code === code ? (
                    <form onSubmit={saveEdit} className="flex flex-wrap items-center gap-2 py-1">
                      <input
                        type="text"
                        value={editing.value}
                        maxLength={BARCODE_MAX_LENGTH}
                        autoFocus
                        autoComplete="off"
                        autoCapitalize="none"
                        spellCheck={false}
                        enterKeyHint="done"
                        aria-label={t("barcodeEditLabel", { code })}
                        disabled={!!busy}
                        onChange={(event) => { setEditing({ code, value: event.target.value }); setError(null); }}
                        className="min-h-[44px] min-w-0 flex-1 basis-40 rounded-lg border border-op-border-2 bg-op-surface px-3 font-mono text-sm focus:border-op-text/40 focus:outline-none disabled:opacity-50"
                      />
                      <button type="submit" disabled={!!busy || !editing.value.trim()} className="mp-btn mp-btn--primary mp-btn--sm shrink-0">
                        {t(busy === code ? "barcodeSaving" : "barcodeSave")}
                      </button>
                      <button type="button" disabled={!!busy} onClick={() => { setEditing(null); setError(null); }} className="mp-btn mp-btn--ghost mp-btn--sm shrink-0">
                        {t("cancel")}
                      </button>
                    </form>
                  ) : (
                    <div className="flex min-h-[44px] items-center gap-2">
                      <InvIcon name="barcode" className="shrink-0 text-op-muted" />
                      <span className="min-w-0 flex-1 py-1">
                        <span className="block break-all font-mono text-sm">{code}</span>
                        {code === ingredient.barcode && <span className="mp-inv-pill mt-0.5">{t("barcodePrimaryBadge")}</span>}
                      </span>
                      {canAdd && (
                        <button
                          type="button"
                          onClick={() => { reset(); setMoving(null); setEditing({ code, value: code }); }}
                          disabled={!!busy}
                          aria-label={t("barcodeEditNamed", { code })}
                          title={t("barcodeEdit")}
                          className="mp-icon-button"
                        >
                          <InvIcon name="pencil" size={17} />
                        </button>
                      )}
                      {targets.length > 0 && (
                        <button
                          type="button"
                          onClick={() => { reset(); setEditing(null); setMoving(moving?.code === code ? null : { code, q: "" }); }}
                          disabled={!!busy}
                          aria-expanded={moving?.code === code}
                          aria-label={t("barcodeMoveNamed", { code })}
                          title={t("barcodeMove")}
                          className="mp-icon-button"
                        >
                          <InvIcon name="swap" size={17} />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => remove(code)}
                        disabled={!!busy}
                        aria-label={t("barcodeRemoveNamed", { code })}
                        className="mp-btn mp-btn--ghost mp-btn--sm mp-inv-remove shrink-0"
                      >
                        {busy === code ? t("saving") : t("barcodeRemove")}
                      </button>
                    </div>
                  )}
                  {moving?.code === code && (
                    <div className="pb-2 pt-1">
                      <label className="block text-xs text-op-muted" htmlFor={`${inputId}-move`}>{t("barcodeMovePick", { code })}</label>
                      <input
                        id={`${inputId}-move`}
                        type="search"
                        value={moving.q}
                        autoFocus
                        autoComplete="off"
                        disabled={!!busy}
                        onChange={(event) => setMoving({ code, q: event.target.value })}
                        placeholder={t("barcodeMoveSearch")}
                        className="mt-1 min-h-[44px] w-full rounded-lg border border-op-border-2 bg-op-surface px-3 text-sm focus:border-op-text/40 focus:outline-none disabled:opacity-50"
                      />
                      {matches.length === 0 ? (
                        <p className="mt-2 text-xs text-op-muted">{t("barcodeMoveEmpty")}</p>
                      ) : (
                        <ul className="mp-tally-pick mt-2">
                          {matches.map((target) => (
                            <li key={target.id}>
                              <button type="button" disabled={!!busy} onClick={() => moveTo(target)}>
                                <span className="min-w-0 flex-1 truncate">{target.name}</span>
                                {target.category && <span className="shrink-0 text-xs text-op-muted">{target.category}</span>}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
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
                  onChange={(event) => { setValue(event.target.value); reset(); }}
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
          {taken && (
            <button type="button" onClick={take} disabled={!!busy} className="mp-btn mp-btn--secondary mp-btn--sm mt-2">
              <InvIcon name="swap" size={16} />
              {busy === "take" ? t("saving") : t("barcodeTakeHere")}
            </button>
          )}
          <p role="status" className="mt-2 min-h-[1.25rem] text-sm text-ok">{status ?? ""}</p>
        </div>
      </div>
    </AppDialog>
  );
}
