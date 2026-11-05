"use client";

import { useEffect, useId, useRef } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatMoney } from "@/lib/format";
import { AppDialog } from "@/components/ui/AppDialog";
import { Icon } from "@/components/ui/Icon";
import { DISPLAY_UNITS, formatBaseQty } from "@/lib/erp/units";
import { sanitizeDecimalInput } from "@/lib/decimalInput";
import {
  formatPct,
  formatUnitCost,
  isParseError,
  unitSymbols,
  type EditLine,
  type IngredientOption,
} from "../recipeModel";
import type { LineView } from "./lineView";
import type { LinesCtl } from "./LinesTable";
import { IngredientCombobox, SubRecipeTag } from "./IngredientCombobox";
import { ReferencePriceFix, UnitHintNote } from "./CostFix";
import { ChevronIcon, InfoIcon, WarningIcon } from "./icons";
import { useLineCopy } from "./lineCopy";

/**
 * Líneas de la receta en el celular: una tarjeta compacta por insumo con
 * cantidad, merma y costo de la línea. Tocarla abre la hoja para editar
 * cantidad, unidad y merma (y corregir el costo si falta).
 */
export function LineCards<L extends EditLine>({
  views,
  ctl,
  signed = false,
  onEdit,
  testId,
}: {
  views: LineView<L>[];
  ctl: LinesCtl<L>;
  signed?: boolean;
  onEdit: (key: number) => void;
  testId?: string;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const copy = useLineCopy();
  if (views.length === 0) return null;
  return (
    <ul
      className="rounded-2xl border border-op-border bg-op-surface divide-y divide-op-border overflow-hidden"
      data-testid={testId}
    >
      {views.map((v) => {
        const l = v.line;
        const parsed = isParseError(v.parsed) ? null : v.parsed;
        const showError = v.error != null && ctl.visibleError(v);
        const meta = parsed
          ? [
              formatBaseQty(parsed.qtyBase, l.measureKind, locale),
              parsed.wastePct > 0
                ? t("rdWasteShort", { pct: parsed.wastePct })
                : null,
            ]
              .filter(Boolean)
              .join(" · ")
          : null;
        return (
          <li key={l.key}>
            <button
              type="button"
              onClick={() => onEdit(l.key)}
              aria-label={t("rdEditLineOf", { name: l.ingredientName })}
              className="w-full min-h-[60px] px-4 py-2.5 flex items-center gap-3 text-left active:bg-op-bg"
              data-line-card={l.key}
            >
              {signed && (
                <span
                  aria-hidden="true"
                  className={
                    "w-7 h-7 shrink-0 grid place-items-center rounded-md border text-sm font-bold " +
                    (l.sign === -1
                      ? "border-danger/40 text-danger bg-danger/10"
                      : "border-ok/40 text-ok bg-ok/10")
                  }
                >
                  {l.sign === -1 ? "−" : "+"}
                </span>
              )}
              <span className="flex-1 min-w-0">
                <span className="flex items-center gap-2 min-w-0">
                  <span className="text-[15px] font-medium truncate">
                    {l.ingredientName}
                  </span>
                  {ctl.subRecipeIds.has(l.ingredientId) && <SubRecipeTag />}
                </span>
                <span
                  className={
                    "block text-[13px] tabular-nums truncate " +
                    (showError || (!parsed && l.qtyRaw.trim() === "")
                      ? "text-danger"
                      : "text-op-muted")
                  }
                >
                  {meta ?? (v.error ? copy.error(l, v.error) : "")}
                </span>
                {v.hint && (
                  <span className="mt-0.5 flex items-center gap-1 text-[12px] text-op-muted">
                    <InfoIcon size={12} />
                    {t("rdUnitHintShort")}
                  </span>
                )}
              </span>
              <span className="text-right shrink-0">
                {v.state !== "ok" ? (
                  <span className="inline-flex items-center gap-1 h-6 px-2 rounded-md bg-warn/15 text-[#7F5A1F] text-[12px] font-medium">
                    <WarningIcon size={12} />
                    {v.state === "zero" ? t("rdZeroCost") : t("noCostBadge")}
                  </span>
                ) : (
                  <>
                    <span className="block text-[15px] font-medium tabular-nums">
                      {v.lineCost != null
                        ? formatMoney(v.lineCost, { currency: ctl.currency, locale })
                        : "—"}
                    </span>
                    {!signed && v.share != null && (
                      <span className="block text-[12px] text-op-muted tabular-nums">
                        {t("rdShareOfCost", { pct: formatPct(v.share, locale) })}
                      </span>
                    )}
                  </>
                )}
              </span>
              <ChevronIcon size={16} className="text-op-muted" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Hoja de una línea (celular): cantidad neta + unidad, merma, lo derivado
 * (bruta, costo unitario con su fuente, costo de la línea) y, si falta, la
 * corrección del costo. Los cambios se aplican al momento; «Listo» cierra.
 */
export function LineEditSheet<L extends EditLine>({
  view: v,
  ctl,
  isNew,
  signed = false,
  onClose,
  onAddAnother,
}: {
  view: LineView<L>;
  ctl: LinesCtl<L>;
  isNew: boolean;
  signed?: boolean;
  onClose: () => void;
  onAddAnother?: () => void;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const copy = useLineCopy();
  const qtyRef = useRef<HTMLInputElement>(null);
  const wasteRef = useRef<HTMLInputElement>(null);
  const qtyId = useId();
  const unitId = useId();
  const wasteId = useId();
  const errId = useId();
  const l = v.line;
  const units = DISPLAY_UNITS[l.measureKind];
  const parsed = isParseError(v.parsed) ? null : v.parsed;
  const showError = v.error != null && ctl.visibleError(v);
  const money = (c: number) => formatMoney(c, { currency: ctl.currency, locale });
  const isSub = ctl.subRecipeIds.has(l.ingredientId);

  // Una línea recién agregada abre con el teclado en la cantidad.
  useEffect(() => {
    if (!isNew) return;
    const frame = requestAnimationFrame(() => qtyRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [isNew, l.key]);

  function done() {
    ctl.touch(l.key);
    onClose();
  }

  const labelCls = "block text-[12px] text-op-muted mb-1";
  const inputCls =
    "w-full min-h-[44px] px-3 rounded-[var(--radius-btn)] border border-op-border bg-op-bg text-base tabular-nums text-op-text focus:outline-none focus:border-op-text/40 aria-[invalid=true]:border-danger/60";

  return (
    <AppDialog
      label={l.ingredientName}
      onClose={done}
      className="mp-sheet mp-sheet--md-center"
    >
      <div className="p-5 pb-4 overflow-y-auto max-h-[85dvh]" data-testid="recipe-line-sheet">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="min-w-0">
            <h3 className="font-display text-2xl leading-tight break-words">
              {l.ingredientName}
            </h3>
            <div className="mt-1 flex items-center gap-2 text-[12px] text-op-muted">
              <span className="font-mono">{unitSymbols(l.measureKind)}</span>
              {isSub && <SubRecipeTag />}
            </div>
          </div>
          <button
            type="button"
            onClick={done}
            aria-label={t("rdLineDone")}
            className="mp-icobtn -mr-2 -mt-1 shrink-0"
          >
            <Icon name="close" width={18} height={18} />
          </button>
        </div>

        {signed && (
          <div className="mp-seg mb-4" role="group" aria-label={t("rdColSign")}>
            <button
              type="button"
              aria-pressed={l.sign !== -1}
              onClick={() => l.sign === -1 && ctl.toggleSign?.(l.key)}
              className="mp-seg__i"
            >
              {t("modSignAdd")}
            </button>
            <button
              type="button"
              aria-pressed={l.sign === -1}
              onClick={() => l.sign !== -1 && ctl.toggleSign?.(l.key)}
              className="mp-seg__i"
            >
              {t("modSignRemove")}
            </button>
          </div>
        )}

        <div className="grid grid-cols-[1fr_96px] gap-3">
          <div>
            <label htmlFor={qtyId} className={labelCls}>
              {t("fieldNetQty")}
            </label>
            <input
              ref={qtyRef}
              id={qtyId}
              type="text"
              inputMode="decimal"
              enterKeyHint="next"
              autoComplete="off"
              value={l.qtyRaw}
              onChange={(e) =>
                ctl.patch(l.key, { qtyRaw: sanitizeDecimalInput(e.target.value) })
              }
              onBlur={() => ctl.touch(l.key)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  wasteRef.current?.focus();
                  wasteRef.current?.select();
                }
              }}
              aria-invalid={(showError && v.error !== "waste_invalid") || undefined}
              aria-describedby={showError ? errId : undefined}
              placeholder="0"
              className={inputCls}
            />
          </div>
          <div>
            <label htmlFor={unitId} className={labelCls}>
              {t("rdColUnit")}
            </label>
            <select
              id={unitId}
              value={l.unit}
              onChange={(e) => ctl.patch(l.key, { unit: e.target.value })}
              disabled={units.length < 2}
              className={inputCls + " disabled:opacity-60"}
            >
              {units.map((u) => (
                <option key={u.symbol} value={u.symbol}>
                  {u.symbol}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={wasteId} className={labelCls}>
              {t("fieldWastePct")}
            </label>
            <input
              ref={wasteRef}
              id={wasteId}
              type="text"
              inputMode="numeric"
              enterKeyHint="done"
              autoComplete="off"
              maxLength={2}
              value={l.wasteRaw}
              onChange={(e) =>
                ctl.patch(l.key, { wasteRaw: e.target.value.replace(/[^\d]/g, "") })
              }
              onBlur={() => ctl.touch(l.key)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  done();
                }
              }}
              aria-invalid={(showError && v.error === "waste_invalid") || undefined}
              aria-describedby={showError ? errId : undefined}
              className={inputCls}
            />
          </div>
          <div>
            <span className={labelCls}>{t("rdColGross")}</span>
            <div className="min-h-[44px] flex items-center text-base tabular-nums text-op-muted">
              {parsed ? formatBaseQty(parsed.grossBase, l.measureKind, locale) : "—"}
            </div>
          </div>
        </div>

        {showError && v.error && (
          <div id={errId} role="alert" className="mt-2 text-xs text-danger">
            {copy.error(l, v.error)}
          </div>
        )}

        <dl className="mt-4 grid grid-cols-2 gap-3 rounded-xl bg-op-bg/70 px-3 py-2.5">
          <div className="min-w-0">
            <dt className="text-[12px] text-op-muted">{t("rdColUnitCost")}</dt>
            <dd className="text-sm tabular-nums">
              {v.state === "ok"
                ? formatUnitCost(v.costPerBase!, l.measureKind, ctl.currency, locale)
                : v.state === "zero"
                  ? t("rdZeroCost")
                  : t("noCostBadge")}
              {v.state === "ok" && (
                <span className="block text-[11px] text-op-muted">
                  {copy.source(v.costSource)}
                </span>
              )}
            </dd>
          </div>
          <div className="min-w-0 text-right">
            <dt className="text-[12px] text-op-muted">{t("rdColLineCost")}</dt>
            <dd className="text-base font-semibold tabular-nums">
              {v.lineCost != null ? money(v.lineCost) : "—"}
              {!signed && v.share != null && (
                <span className="block text-[11px] font-normal text-op-muted">
                  {t("rdShareOfCost", { pct: formatPct(v.share, locale) })}
                </span>
              )}
            </dd>
          </div>
        </dl>

        {v.state !== "ok" && (
          <div className="mt-3">
            <ReferencePriceFix
              ingredientId={l.ingredientId}
              name={l.ingredientName}
              measureKind={l.measureKind}
              state={v.state}
              source={v.costSource}
              isSubRecipe={isSub}
              currency={ctl.currency}
              onSaved={(cents) => ctl.fixSaved(v, cents)}
            />
          </div>
        )}

        {v.hint && parsed && (
          <div className="mt-3">
            <UnitHintNote
              ingredientId={l.ingredientId}
              name={l.ingredientName}
              qtyBase={parsed.qtyBase}
              measureKind={l.measureKind}
            />
          </div>
        )}

        <div className="sticky bottom-0 -mx-5 -mb-4 mt-5 px-5 pt-3 pb-4 bg-op-surface border-t border-op-border flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              ctl.remove(l.key);
              onClose();
            }}
            className="mp-btn mp-btn--ghost text-danger! hover:bg-danger/10!"
          >
            {t("rdRemoveIngredient")}
          </button>
          <div className="flex-1" />
          {isNew && onAddAnother && (
            <button
              type="button"
              onClick={() => {
                ctl.touch(l.key);
                onAddAnother();
              }}
              className="mp-btn mp-btn--secondary"
            >
              {t("rdAddAnother")}
            </button>
          )}
          <button type="button" onClick={done} className="mp-btn mp-btn--primary">
            {t("rdLineDone")}
          </button>
        </div>
      </div>
    </AppDialog>
  );
}

/** Hoja para elegir el insumo a agregar (celular): el buscador a lo ancho. */
export function AddIngredientSheet({
  title,
  options,
  subRecipeIds,
  currency,
  onPick,
  onClose,
}: {
  title: string;
  options: readonly IngredientOption[];
  subRecipeIds: ReadonlySet<string>;
  currency: string;
  onPick: (o: IngredientOption) => void;
  onClose: () => void;
}) {
  const t = useTranslations("opErp");
  return (
    <AppDialog label={title} onClose={onClose} className="mp-sheet mp-sheet--md-center">
      <div className="p-5 min-h-[60dvh]" data-testid="recipe-add-sheet">
        <div className="flex items-center justify-between gap-3 mb-3">
          <h3 className="font-display text-2xl">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("cancel")}
            className="mp-icobtn -mr-2 shrink-0"
          >
            <Icon name="close" width={18} height={18} />
          </button>
        </div>
        <IngredientCombobox
          autoFocus
          options={options}
          subRecipeIds={subRecipeIds}
          currency={currency}
          onPick={onPick}
          placeholder={t("rdAddPlaceholder")}
          ariaLabel={title}
        />
      </div>
    </AppDialog>
  );
}
