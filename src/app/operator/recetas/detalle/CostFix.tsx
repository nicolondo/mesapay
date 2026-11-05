"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatBaseQty, type MeasureKind } from "@/lib/erp/units";
import {
  parseReferencePriceInput,
  referencePriceUnit,
} from "@/lib/erp/ingredientPrice";
import { MoneyInput } from "@/components/MoneyInput";
import type { LineCostState } from "@/lib/erp/recipeDetail";
import type { CostSource } from "../recipeModel";
import { ExternalIcon, InfoIcon, WarningIcon } from "./icons";

/** Ficha del insumo (Insumos abre su hoja de edición con `?editar=`). */
export function ingredientHref(ingredientId: string): string {
  return `/operator/settings/insumos?editar=${encodeURIComponent(ingredientId)}`;
}

/** «Abrir insumo» en otra pestaña: la receta que se edita no se pierde. */
export function IngredientLink({
  ingredientId,
  label,
  className = "",
}: {
  ingredientId: string;
  label: string;
  className?: string;
}) {
  const t = useTranslations("opErp");
  return (
    <a
      href={ingredientHref(ingredientId)}
      target="_blank"
      rel="noopener"
      className={
        "inline-flex items-center gap-1 font-medium underline underline-offset-2 hover:no-underline " +
        className
      }
    >
      {label}
      <ExternalIcon size={12} />
      <span className="sr-only">{t("rdOpensNewTab")}</span>
    </a>
  );
}

/**
 * Corrección en línea de un insumo sin costo (o en $0): explica por qué y,
 * cuando sirve, deja ponerle el precio de referencia ahí mismo — el mismo
 * PATCH de Insumos (validación y auditoría de la ficha). Al guardar, la
 * línea se recostea al instante y la lista de recetas se recarga.
 */
export function ReferencePriceFix({
  ingredientId,
  name,
  measureKind,
  state,
  source,
  isSubRecipe,
  currency,
  autoFocus = false,
  onSaved,
}: {
  ingredientId: string;
  name: string;
  measureKind: MeasureKind;
  state: Exclude<LineCostState, "ok">;
  source: CostSource;
  isSubRecipe: boolean;
  currency: string;
  autoFocus?: boolean;
  onSaved: (referencePriceCents: number) => void;
}) {
  const t = useTranslations("opErp");
  const inputId = useId();
  const errId = useId();
  const wrapRef = useRef<HTMLFormElement>(null);
  const unit = referencePriceUnit(measureKind);
  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Una sub-receta que cuesta $0 manda sobre el precio de referencia: ahí
  // no sirve escribir un precio, hay que revisar la sub-receta.
  const priceHelps = !(state === "zero" && source === "subrecipe");

  useEffect(() => {
    if (!autoFocus || !priceHelps) return;
    const frame = requestAnimationFrame(() =>
      wrapRef.current?.querySelector("input")?.focus(),
    );
    return () => cancelAnimationFrame(frame);
  }, [autoFocus, priceHelps]);

  const message =
    state === "zero"
      ? source === "subrecipe"
        ? t("rdFixZeroSub", { name })
        : t("rdFixZero", { name })
      : isSubRecipe
        ? t("rdFixNoneSub", { name })
        : t("rdFixNone", { name });

  async function save() {
    if (busy) return;
    setErr(null);
    const cents = parseReferencePriceInput(raw);
    if (cents === "invalid") {
      setErr(t("errCostInvalid"));
      return;
    }
    if (cents == null || cents <= 0) {
      setErr(t("costGapErrNeedsPrice"));
      return;
    }
    setBusy(true);
    try {
      const r = await fetch(`/api/operator/ingredients/${ingredientId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ referencePriceCents: cents }),
      });
      if (!r.ok) throw new Error("save_failed");
      onSaved(cents);
    } catch {
      setErr(t("errSaveFailed"));
    } finally {
      setBusy(false);
    }
  }

  const label = t("ingredientReferenceLabel", { currency, unit });

  return (
    <form
      ref={wrapRef}
      className="flex flex-col gap-2 rounded-xl border border-warn/40 bg-warn/[0.07] px-3 py-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      data-testid="recipe-cost-fix"
    >
      <div className="flex items-start gap-2 text-[13px] leading-5 text-op-text">
        <WarningIcon size={15} className="mt-0.5 text-[#7F5A1F]" />
        <span className="min-w-0">{message}</span>
      </div>
      {priceHelps && (
        <div className="flex flex-wrap items-center gap-2 pl-[23px]">
          <label htmlFor={inputId} className="sr-only">
            {label}
          </label>
          <div className="w-[180px] max-w-full">
            <MoneyInput
              id={inputId}
              value={raw}
              onChange={(v) => {
                setErr(null);
                setRaw(v);
              }}
              fractionDigits={2}
              ariaLabel={label}
              placeholder={t("rdFixPricePlaceholder", { unit })}
              aria-invalid={err ? true : undefined}
              aria-describedby={err ? errId : undefined}
              disabled={busy}
              className="w-full h-9 px-3 rounded-[var(--radius-btn)] border border-op-border bg-op-surface text-sm tabular-nums focus:outline-none focus:border-op-text/40"
            />
          </div>
          <button
            type="submit"
            className="mp-btn mp-btn--primary mp-btn--sm"
            disabled={busy}
          >
            {busy ? t("saving") : t("rdFixSave")}
          </button>
          <span className="text-[11px] text-op-muted">
            {t("costGapPriceHint", { unit })}
          </span>
        </div>
      )}
      {err && (
        <div id={errId} role="alert" className="pl-[23px] text-xs text-danger">
          {err}
        </div>
      )}
      <div className="pl-[23px] text-[12px] text-op-muted">
        <IngredientLink
          ingredientId={ingredientId}
          label={t("rdOpenIngredient")}
          className="text-op-text"
        />
      </div>
    </form>
  );
}

/**
 * Aviso suave de unidad sospechosa (0,002 un de sal): solo sugiere revisar
 * la dimensión del insumo; nunca cambia datos por su cuenta.
 */
export function UnitHintNote({
  ingredientId,
  name,
  qtyBase,
  measureKind,
}: {
  ingredientId: string;
  name: string;
  qtyBase: number;
  measureKind: MeasureKind;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  return (
    <div
      className="flex items-start gap-2 text-[12px] leading-5 text-op-muted"
      data-testid="recipe-unit-hint"
    >
      <InfoIcon size={14} className="mt-[3px]" />
      <span className="min-w-0">
        {t("rdUnitHintTiny", {
          qty: formatBaseQty(qtyBase, measureKind, locale),
          name,
        })}{" "}
        <IngredientLink
          ingredientId={ingredientId}
          label={t("rdUnitHintAction")}
          className="text-op-text"
        />
      </span>
    </div>
  );
}
