"use client";

import { useId, useRef } from "react";
import type { KeyboardEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatMoney } from "@/lib/format";
import { Icon } from "@/components/ui/Icon";
import { DISPLAY_UNITS, formatBaseQty } from "@/lib/erp/units";
import { MAX_WASTE_PCT } from "@/lib/erp/recipes";
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
import { IngredientCombobox, SubRecipeTag } from "./IngredientCombobox";
import { ReferencePriceFix, UnitHintNote } from "./CostFix";
import { WarningIcon } from "./icons";
import { useLineCopy } from "./lineCopy";

/** Lo que el detalle le pasa a cada tabla de líneas (base o de una opción). */
export type LinesCtl<L extends EditLine> = {
  currency: string;
  subRecipeIds: ReadonlySet<string>;
  /** Error visible de la línea (tras tocarla o al intentar guardar). */
  visibleError: (v: LineView<L>) => boolean;
  fixOpen: ReadonlySet<number>;
  toggleFix: (key: number) => void;
  fixSaved: (v: LineView<L>, referencePriceCents: number) => void;
  patch: (key: number, patch: Partial<EditLine>) => void;
  remove: (key: number) => void;
  toggleSign?: (key: number) => void;
  touch: (key: number) => void;
};

/**
 * Tabla de líneas de la receta (escritorio): una fila de ~44 px por insumo
 * con cantidad neta, unidad, merma, bruta, costo unitario con su fuente,
 * costo de la línea y su parte del total. Solo cuando hace falta, una
 * franja debajo de la fila: la corrección del costo, el aviso de unidad o
 * el error de la cantidad. Al final, la fila para agregar insumos.
 *
 * Teclado: en el buscador, Enter agrega y salta a la cantidad; en cantidad
 * o merma, Enter vuelve al buscador y ↑/↓ cambian de fila.
 */
export function LinesTable<L extends EditLine>({
  views,
  ctl,
  addOptions,
  onAdd,
  addPlaceholder,
  signed = false,
  total,
  emptyText,
  testId,
}: {
  views: LineView<L>[];
  ctl: LinesCtl<L>;
  addOptions: readonly IngredientOption[];
  onAdd: (o: IngredientOption) => void;
  addPlaceholder: string;
  /** Líneas de modificador: con el toggle agrega/quita y sin columna «%». */
  signed?: boolean;
  /** Fila de total (solo la receta base). */
  total?: { cents: number; complete: boolean } | null;
  /** Texto cuando todavía no hay líneas. */
  emptyText?: string;
  testId?: string;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const rootRef = useRef<HTMLDivElement>(null);

  function focusCell(key: number, col: "qty" | "waste") {
    const el = rootRef.current?.querySelector<HTMLInputElement>(
      `[data-line="${key}"] [data-col="${col}"]`,
    );
    el?.focus();
    el?.select();
  }

  function focusAdd() {
    rootRef.current
      ?.querySelector<HTMLInputElement>("[data-recipe-add]")
      ?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTableElement>) {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement;
    const col = target.dataset.col;
    if (col !== "qty" && col !== "waste") return;
    const key = Number(target.closest<HTMLElement>("[data-line]")?.dataset.line);
    const row = views.findIndex((v) => v.line.key === key);
    if (row < 0) return;
    if (e.key === "Enter") {
      e.preventDefault();
      ctl.touch(key);
      focusAdd();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const next = views[row + (e.key === "ArrowDown" ? 1 : -1)];
      if (!next) return;
      e.preventDefault();
      focusCell(next.line.key, col);
    }
  }

  const colCount = 9;
  // Encabezado fijo arriba mientras se desplazan las líneas.
  const th =
    "sticky top-0 z-[1] bg-op-surface py-2 px-2 font-mono text-[10px] tracking-[0.12em] uppercase text-op-muted font-normal border-b border-op-border whitespace-nowrap";

  return (
    <div ref={rootRef} data-testid={testId}>
      <table
        className="w-full table-fixed border-separate border-spacing-0"
        onKeyDown={onKeyDown}
      >
        <colgroup>
          {signed && <col className="w-[52px]" />}
          <col />
          <col className="w-[96px]" />
          <col className="w-[72px]" />
          <col className="w-[78px]" />
          <col className="w-[92px]" />
          <col className="w-[150px] xl:w-[168px]" />
          <col className="w-[104px]" />
          {!signed && <col className="w-[96px]" />}
          <col className="w-[44px]" />
        </colgroup>
        <thead>
          <tr>
            {signed && (
              <th className={th + " text-left"} scope="col">
                <span className="sr-only">{t("rdColSign")}</span>
              </th>
            )}
            <th className={th + " text-left pl-3"} scope="col">
              {t("fieldIngredient")}
            </th>
            <th className={th + " text-right"} scope="col">
              {t("rdColNet")}
            </th>
            <th className={th + " text-left"} scope="col">
              {t("rdColUnit")}
            </th>
            <th className={th + " text-right"} scope="col">
              {t("rdColWaste")}
            </th>
            <th className={th + " text-right"} scope="col">
              {t("rdColGross")}
            </th>
            <th className={th + " text-right"} scope="col">
              {t("rdColUnitCost")}
            </th>
            <th className={th + " text-right"} scope="col">
              {t("rdColLineCost")}
            </th>
            {!signed && (
              <th className={th + " text-right"} scope="col">
                {t("rdColShare")}
              </th>
            )}
            <th className={th} scope="col">
              <span className="sr-only">{t("removeLine")}</span>
            </th>
          </tr>
        </thead>
        {views.map((v) => (
          <LineRow key={v.line.key} view={v} ctl={ctl} signed={signed} colCount={colCount} />
        ))}
        {views.length === 0 && emptyText && (
          <tbody>
            <tr>
              <td
                colSpan={colCount}
                className="px-3 py-5 text-center text-sm text-op-muted border-b border-op-border"
              >
                {emptyText}
              </td>
            </tr>
          </tbody>
        )}
        <tbody>
          <tr>
            <td colSpan={colCount} className="px-2 pt-2 pb-1">
              <div className="flex items-center gap-3">
                <span
                  aria-hidden="true"
                  className="w-8 h-8 grid place-items-center rounded-md text-op-muted shrink-0"
                >
                  <Icon name="plus" width={16} height={16} />
                </span>
                <div className="w-[min(440px,100%)]">
                  <IngredientCombobox
                    floating
                    options={addOptions}
                    subRecipeIds={ctl.subRecipeIds}
                    currency={ctl.currency}
                    onPick={onAdd}
                    placeholder={addPlaceholder}
                    ariaLabel={addPlaceholder}
                    inputClassName="w-full h-9 px-3 rounded-[var(--radius-btn)] border border-dashed border-op-border-2 bg-transparent text-sm text-op-text placeholder:text-op-muted hover:border-op-text/30 focus:border-solid focus:border-op-text/40 focus:bg-op-surface focus:outline-none"
                  />
                </div>
                <span className="text-[11px] text-op-muted hidden xl:inline">
                  {t("rdAddHint")}
                </span>
              </div>
            </td>
          </tr>
        </tbody>
        {total && views.length > 0 && (
          <tfoot>
            <tr>
              <td
                colSpan={signed ? 7 : 6}
                className="px-3 pt-3 pb-2 border-t border-op-border text-[12px] text-op-muted"
              >
                {t("rdTotalRow", { count: views.length })}
              </td>
              <td className="px-2 pt-3 pb-2 border-t border-op-border text-right">
                <div className="text-sm font-semibold tabular-nums">
                  {formatMoney(total.cents, { currency: ctl.currency, locale })}
                </div>
                {!total.complete && (
                  <div className="text-[10px] text-[#7F5A1F]">
                    {t("rdPartialShort")}
                  </div>
                )}
              </td>
              {!signed && (
                <td className="px-2 pt-3 pb-2 border-t border-op-border text-right text-[12px] text-op-muted tabular-nums">
                  {total.cents > 0 ? formatPct(100, locale) : "—"}
                </td>
              )}
              <td className="border-t border-op-border" />
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

function LineRow<L extends EditLine>({
  view: v,
  ctl,
  signed,
  colCount,
}: {
  view: LineView<L>;
  ctl: LinesCtl<L>;
  signed: boolean;
  colCount: number;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const copy = useLineCopy();
  const errId = useId();
  const fixId = useId();
  const l = v.line;
  const name = l.ingredientName;
  const units = DISPLAY_UNITS[l.measureKind];
  const showError = v.error != null && ctl.visibleError(v);
  const missing = v.state !== "ok";
  const fixOpen = missing && ctl.fixOpen.has(l.key);
  const parsed = isParseError(v.parsed) ? null : v.parsed;
  const hasStrip = fixOpen || showError || (v.hint != null && parsed != null);
  const td = "px-2 py-1 align-middle" + (hasStrip ? "" : " border-b border-op-border");
  const label = (col: string) => `${col} · ${name}`;
  const isSub = ctl.subRecipeIds.has(l.ingredientId);
  const money = (c: number) => formatMoney(c, { currency: ctl.currency, locale });
  const qtyErr = showError && v.error !== "waste_invalid";
  const wasteErr = showError && v.error === "waste_invalid";

  return (
    <tbody data-line={l.key} className="group">
      <tr className="h-11 group-hover:bg-op-bg/60 group-focus-within:bg-op-bg/80 transition-colors">
        {signed && (
          <td className={td}>
            <button
              type="button"
              onClick={() => ctl.toggleSign?.(l.key)}
              aria-label={l.sign === -1 ? t("modSignRemove") : t("modSignAdd")}
              title={l.sign === -1 ? t("modSignRemove") : t("modSignAdd")}
              className={
                "w-9 h-9 rounded-md border text-base font-bold " +
                (l.sign === -1
                  ? "border-danger/40 text-danger bg-danger/10"
                  : "border-ok/40 text-ok bg-ok/10")
              }
            >
              {l.sign === -1 ? "−" : "+"}
            </button>
          </td>
        )}
        <td className={td + " pl-3"}>
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-medium truncate" title={name}>
              {name}
            </span>
            <span className="font-mono text-[10px] text-op-muted shrink-0">
              {unitSymbols(l.measureKind)}
            </span>
            {isSub && <SubRecipeTag />}
          </div>
        </td>
        <td className={td}>
          <input
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={l.qtyRaw}
            onChange={(e) =>
              ctl.patch(l.key, { qtyRaw: sanitizeDecimalInput(e.target.value) })
            }
            onBlur={() => ctl.touch(l.key)}
            aria-label={label(t("fieldNetQty"))}
            aria-invalid={qtyErr || undefined}
            aria-describedby={qtyErr ? errId : undefined}
            placeholder="0"
            data-col="qty"
            className={cellInputCls + " text-right"}
          />
        </td>
        <td className={td}>
          {units.length < 2 ? (
            <span className="px-2 text-sm text-op-muted">{units[0]!.symbol}</span>
          ) : (
            <select
              value={l.unit}
              onChange={(e) => ctl.patch(l.key, { unit: e.target.value })}
              aria-label={label(t("rdColUnit"))}
              data-col="unit"
              className={cellInputCls + " pr-1"}
            >
              {units.map((u) => (
                <option key={u.symbol} value={u.symbol}>
                  {u.symbol}
                </option>
              ))}
            </select>
          )}
        </td>
        <td className={td}>
          <div className="relative">
            <input
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={l.wasteRaw}
              onChange={(e) =>
                ctl.patch(l.key, { wasteRaw: e.target.value.replace(/[^\d]/g, "") })
              }
              onBlur={() => ctl.touch(l.key)}
              aria-label={label(t("fieldWastePct"))}
              aria-invalid={wasteErr || undefined}
              aria-describedby={wasteErr ? errId : undefined}
              maxLength={2}
              data-col="waste"
              title={t("rdWasteTitle", { max: MAX_WASTE_PCT })}
              className={cellInputCls + " text-right pr-6"}
            />
            <span
              aria-hidden="true"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-op-muted pointer-events-none"
            >
              {"%"}
            </span>
          </div>
        </td>
        <td className={td + " text-right text-[13px] text-op-muted tabular-nums whitespace-nowrap"}>
          {parsed ? formatBaseQty(parsed.grossBase, l.measureKind, locale) : "—"}
        </td>
        <td className={td + " text-right"}>
          {missing ? (
            <button
              type="button"
              onClick={() => ctl.toggleFix(l.key)}
              aria-expanded={fixOpen}
              aria-controls={fixOpen ? fixId : undefined}
              title={v.state === "zero" ? t("rdZeroCostTitle") : t("rdNoCostTitle")}
              className="inline-flex items-center gap-1 h-7 px-2 rounded-md bg-warn/15 text-[#7F5A1F] text-[12px] font-medium hover:bg-warn/25"
              data-testid="recipe-no-cost"
            >
              <WarningIcon size={13} />
              {v.state === "zero" ? t("rdZeroCost") : t("noCostBadge")}
            </button>
          ) : (
            <div className="leading-tight">
              <div className="text-[13px] tabular-nums whitespace-nowrap">
                {formatUnitCost(v.costPerBase!, l.measureKind, ctl.currency, locale)}
              </div>
              <div className="text-[10px] text-op-muted truncate">
                {copy.source(v.costSource)}
              </div>
            </div>
          )}
        </td>
        <td className={td + " text-right text-sm font-medium tabular-nums whitespace-nowrap"}>
          {v.lineCost != null ? (
            money(v.lineCost)
          ) : (
            <span className="text-op-muted font-normal">{"—"}</span>
          )}
        </td>
        {!signed && (
          <td className={td + " text-right"}>
            <ShareCell pct={v.share} locale={locale} />
          </td>
        )}
        <td className={td + " pr-2 text-right"}>
          <button
            type="button"
            onClick={() => ctl.remove(l.key)}
            aria-label={t("rdRemoveLineOf", { name })}
            title={t("rdRemoveLineOf", { name })}
            className="w-8 h-8 inline-flex items-center justify-center rounded-md text-op-muted opacity-60 group-hover:opacity-100 focus-visible:opacity-100 hover:text-danger hover:bg-danger/10 transition"
          >
            <Icon name="close" width={15} height={15} />
          </button>
        </td>
      </tr>
      {hasStrip && (
        <tr className="group-hover:bg-op-bg/60 group-focus-within:bg-op-bg/80">
          <td colSpan={colCount} className="px-3 pb-2.5 pt-0.5 border-b border-op-border">
            <div className={"flex flex-col gap-2 " + (signed ? "pl-[52px]" : "")}>
              {showError && v.error && (
                <div
                  id={errId}
                  role="alert"
                  className="inline-flex items-center gap-1.5 text-xs text-danger"
                >
                  {copy.error(l, v.error)}
                </div>
              )}
              {fixOpen && v.state !== "ok" && (
                <div id={fixId}>
                  <ReferencePriceFix
                    ingredientId={l.ingredientId}
                    name={name}
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
                <UnitHintNote
                  ingredientId={l.ingredientId}
                  name={name}
                  qtyBase={parsed.qtyBase}
                  measureKind={l.measureKind}
                />
              )}
            </div>
          </td>
        </tr>
      )}
    </tbody>
  );
}

/** «29 %» con una barra fina de un solo tono (la parte del costo total). */
function ShareCell({ pct, locale }: { pct: number | null; locale: string }) {
  if (pct == null) return <span className="text-[12px] text-op-muted">{"—"}</span>;
  const w = Math.min(Math.max(pct, 0), 100);
  return (
    <div className="flex items-center justify-end gap-2">
      <span
        aria-hidden="true"
        className="relative w-9 h-1 rounded-full bg-op-border overflow-hidden"
      >
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-op-text/55"
          style={{ width: `${w}%` }}
        />
      </span>
      <span className="text-[12px] tabular-nums text-op-text w-[42px] text-right">
        {formatPct(pct, locale)}
      </span>
    </div>
  );
}

const cellInputCls =
  "w-full h-9 px-2 rounded-md border border-op-border bg-op-surface text-sm tabular-nums text-op-text placeholder:text-op-muted/60 hover:border-op-text/25 focus:border-op-text/40 focus:outline-none aria-[invalid=true]:border-danger/60 aria-[invalid=true]:bg-danger/5";
