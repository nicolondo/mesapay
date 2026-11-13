"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { AppDialog } from "@/components/ui/AppDialog";
import { ingredientMatchesSearch } from "@/lib/erp/ingredientSearch";
import { IngredientInlineForm, type IngredientConflict, type IngredientRef } from "../compras/shared";
import { InvIcon } from "./InventoryIcons";
import type { CountItemRow } from "./types";

/**
 * Elegir un insumo de ESTE conteo (para vincularle o pasarle un código).
 * Hoja compacta sobre el conteo: lo digitado en el conteo sigue ahí debajo.
 */
export function CountItemPicker({ title, intro, items, busy, onPick, onClose }: {
  title: string;
  intro: string;
  items: readonly CountItemRow[];
  busy: boolean;
  onPick: (item: CountItemRow) => void;
  onClose: () => void;
}) {
  const t = useTranslations("opErp");
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const matches = useMemo(
    () => items.filter((item) => item.ingredient.active && item.ingredient.trackInventory && ingredientMatchesSearch(item.ingredient, q)).slice(0, 60),
    [items, q],
  );
  // Con teclado, el buscador queda listo; en táctil no se abre el teclado solo.
  useEffect(() => {
    if (!window.matchMedia("(pointer: fine)").matches) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <AppDialog label={title} onClose={() => { if (!busy) onClose(); }} dismissOnBackdrop={false} className="mp-sheet mp-sheet--md-center">
      <div className="flex max-h-[85dvh] flex-col">
        <div className="flex items-start justify-between gap-3 border-b border-op-border py-4 pl-5 pr-3">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
            <p className="mt-0.5 text-sm text-op-muted">{intro}</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label={t("closeSheet")} className="mp-icon-button shrink-0">
            <InvIcon name="close" size={20} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
          <input
            ref={inputRef}
            type="search"
            value={q}
            autoComplete="off"
            disabled={busy}
            onChange={(event) => setQ(event.target.value)}
            placeholder={t("countPickSearch")}
            aria-label={t("countPickSearch")}
            className="min-h-[44px] w-full rounded-lg border border-op-border-2 bg-op-surface px-3 text-sm focus:border-op-text/40 focus:outline-none disabled:opacity-50"
          />
          {matches.length === 0 ? (
            <p className="mt-3 text-sm text-op-muted">{t("emptyFiltered")}</p>
          ) : (
            <ul className="mp-tally-pick mt-3" style={{ maxHeight: "none" }}>
              {matches.map((item) => (
                <li key={item.id}>
                  <button type="button" disabled={busy} onClick={() => onPick(item)}>
                    <span className="min-w-0 flex-1 truncate">{item.ingredient.name}</span>
                    {item.ingredient.category && <span className="shrink-0 text-xs text-op-muted">{item.ingredient.category}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </AppDialog>
  );
}

/**
 * «Nuevo insumo» sin salir del conteo. Reutiliza el alta rápida de Compras
 * (mismas validaciones y la misma API) con el código de barras, las
 * categorías que ya existen y las unidades de cada dimensión. Al crearlo, el
 * conteo lo suma con existencia 0 y deja lista su cantidad.
 */
export function CountNewIngredientDialog({ initialName, initialBarcode, categories, scopeCategory, onCreated, onCancel, conflictActions }: {
  initialName?: string;
  initialBarcode?: string;
  categories: readonly string[];
  /** Categoría del conteo cuando se abrió para una sola. */
  scopeCategory: string | null;
  onCreated: (ingredient: IngredientRef) => void;
  onCancel: () => void;
  conflictActions: (conflict: IngredientConflict, busy: boolean) => React.ReactNode;
}) {
  const t = useTranslations("opErp");
  return (
    <AppDialog label={t("newIngredient")} onClose={onCancel} dismissOnBackdrop={false} className="mp-sheet mp-sheet--md-center">
      <div className="max-h-[85dvh] overflow-y-auto overscroll-contain p-5">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-lg font-semibold tracking-tight">{t("newIngredient")}</h2>
          <button type="button" onClick={onCancel} aria-label={t("cancel")} className="mp-icon-button -mr-2 -mt-1 shrink-0">
            <InvIcon name="close" size={20} />
          </button>
        </div>
        <p className="mt-1 text-sm text-op-muted">{t("countNewIngredientIntro")}</p>
        <IngredientInlineForm
          initialName={initialName}
          initialBarcode={initialBarcode}
          initialCategory={scopeCategory ?? undefined}
          categories={categories}
          withBarcode
          showUnits
          categoryNote={(category) => (scopeCategory && category !== scopeCategory ? t("countNewIngredientOutsideScope", { category: scopeCategory }) : null)}
          conflictActions={conflictActions}
          onCreated={onCreated}
          onCancel={onCancel}
        />
      </div>
    </AppDialog>
  );
}
