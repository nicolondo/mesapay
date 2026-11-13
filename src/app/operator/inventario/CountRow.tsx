"use client";

import { memo } from "react";
import { useTranslations } from "next-intl";
import { sanitizeDecimalInput } from "@/lib/decimalInput";
import { countRowState, type CountRowState } from "@/lib/erp/countView";
import { formatCountQty, parseCountEntries, parseCountEntry, type CountEntry } from "@/lib/erp/stockCountInput";
import { effectiveCountParts, MAX_COUNT_PARTS } from "@/lib/erp/stockCountParts";
import { DISPLAY_UNITS } from "@/lib/erp/units";
import { InvIcon, type InventoryIconName } from "./InventoryIcons";
import type { CountItemRow } from "./types";

/** Manejadores estables (no cambian entre renders): la fila es `memo`. */
export type CountRowHandlers = {
  setInputRef: (itemId: string, index: number, element: HTMLInputElement | null) => void;
  onChange: (itemId: string, index: number, change: Partial<CountEntry>) => void;
  onEnter: (itemId: string, index: number) => void;
  onRemove: (itemId: string, index: number) => void;
  onAdd: (itemId: string) => void;
  onToggleParts: (itemId: string) => void;
  /** El foco salió de la fila: recién ahí sube a «contados recientemente». */
  onLeave: (itemId: string, next: Element | null) => void;
  onCodes: (itemId: string) => void;
};

type Props = {
  item: CountItemRow;
  entries: CountEntry[];
  canEdit: boolean;
  /** Etapa definitiva: se compara contra la existencia al iniciarla. */
  finalStage: boolean;
  /** Ya hay preliminar: se muestra el primer conteo como referencia. */
  showPreliminary: boolean;
  /** El conteo no está cerrado: se pueden corregir los códigos del insumo. */
  codesEnabled: boolean;
  busy: boolean;
  locale: string;
  /** Fila del último escaneo («es esta»). */
  hit: boolean;
  /** Cantidades parciales desplegadas (solo una fila a la vez). */
  expanded: boolean;
  /** Parte marcada por un Enter sin cantidad válida. */
  errorIndex: number | null;
  /** Hay un código escaneado sin dueño: el botón de códigos lo recibe. */
  codesAccent: boolean;
  /**
   * Conteo definitivo: por qué hay que recontarlo («difference», «uncounted»,
   * «moved», separados por coma) o «confirmed» si quedó confirmado del
   * preliminar. Vacío en las demás etapas.
   */
  tags: string;
  enterHintId: string;
  handlers: CountRowHandlers;
};

const TAG_LABEL: Record<string, string> = {
  difference: "countReasonDifference", uncounted: "countReasonUncounted", moved: "countReasonMoved", confirmed: "countConfirmedTag",
};

const STATE_ICON: Record<CountRowState, InventoryIconName> = {
  untracked: "minus", pending: "circle", invalid: "alert", equal: "check", shortage: "arrowDown", surplus: "arrowUp",
};
const STATE_LABEL: Record<CountRowState, string> = {
  untracked: "nonInventoriable", pending: "notCounted", invalid: "countStateInvalid", equal: "countEqual", shortage: "countShortage", surplus: "countSurplus",
};

/**
 * Un insumo del conteo en UNA línea: estado, nombre y categoría, cantidad +
 * unidad (o el chip «N cantidades» cuando se contó en varias partes), total,
 * esperado y diferencia. Las partes se despliegan debajo solo en esta fila.
 */
export const CountRow = memo(function CountRow({
  item, entries, canEdit, finalStage, showPreliminary, codesEnabled, busy, locale, hit, expanded, errorIndex, codesAccent, tags, enterHintId, handlers,
}: Props) {
  const t = useTranslations("opErp");
  const { ingredient } = item;
  const name = ingredient.name;
  const kind = ingredient.measureKind;
  const tracked = ingredient.trackInventory;
  const units = DISPLAY_UNITS[kind];
  const baseline = finalStage ? (item.finalExpectedQty ?? item.expectedQty) : item.expectedQty;

  const parsed = canEdit ? parseCountEntries(entries, kind) : null;
  const value = canEdit ? (parsed === "invalid" ? "invalid" as const : parsed!.countedQty) : item.countedQty;
  const state = countRowState(value, baseline, tracked);
  const savedParts = canEdit ? [] : effectiveCountParts(item.countedQty, item.countedParts);
  const multi = canEdit ? entries.length > 1 : savedParts.length > 1;
  const partCount = canEdit ? entries.length : savedParts.length;
  const diff = value != null && value !== "invalid" ? value - baseline : null;
  const diffText = diff == null ? "—" : (diff > 0 ? "+" : diff < 0 ? "−" : "") + formatCountQty(Math.abs(diff), kind, locale);
  const expectedLabel = t(finalStage ? "countFinalExpectedLabel" : "countInitialExpectedLabel");
  const initialParts = showPreliminary ? effectiveCountParts(item.preliminaryQty, item.preliminaryParts) : [];
  const msgId = `count-row-${item.id}-msg`;
  const disabled = busy || !tracked;

  const entryInvalid = (index: number) => {
    const entry = entries[index];
    const amount = parseCountEntry(entry.raw, kind, entry.unit);
    return amount === "invalid" || (errorIndex === index && (amount === null || value === "invalid"));
  };
  const anyInvalid = canEdit && tracked && (value === "invalid" || errorIndex !== null);
  const errorText = !anyInvalid ? null
    : value === "invalid" && entries.every((entry) => parseCountEntry(entry.raw, kind, entry.unit) !== "invalid")
      ? t("countPartsInvalidTotal")
      : t("countQuantityEnterError");

  const field = (index: number) => {
    const entry = entries[index];
    const invalid = entryInvalid(index);
    return (
      <>
        <input
          ref={(element) => handlers.setInputRef(item.id, index, element)}
          type="text" inputMode="decimal" enterKeyHint="next" autoComplete="off"
          aria-label={index === 0 ? t("countQuantityLabel", { name }) : t("countPartQuantityLabel", { number: index + 1, name })}
          aria-describedby={tracked ? (invalid ? msgId : enterHintId) : undefined}
          aria-invalid={invalid}
          disabled={disabled} value={entry.raw} placeholder={t("notCounted")}
          onChange={(event) => handlers.onChange(item.id, index, { raw: sanitizeDecimalInput(event.target.value) })}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            handlers.onEnter(item.id, index);
          }}
          className="mp-tally-input"
        />
        <select
          value={entry.unit}
          aria-label={index === 0 ? t("countUnitLabel", { name }) : t("countPartUnitLabel", { number: index + 1, name })}
          onChange={(event) => handlers.onChange(item.id, index, { unit: event.target.value })}
          disabled={disabled || units.length < 2}
          className="mp-tally-unit"
        >
          {units.map((unit) => <option key={unit.symbol} value={unit.symbol}>{unit.symbol}</option>)}
        </select>
      </>
    );
  };

  return (
    <div
      className={"mp-tally-row" + (hit ? " is-hit" : "")}
      data-count-row={item.id}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        handlers.onLeave(item.id, event.relatedTarget as Element | null);
      }}
    >
      <div className="mp-tally-row__head">
        <span className="mp-tally-state" data-state={state} title={t(STATE_LABEL[state])}>
          <InvIcon name={STATE_ICON[state]} size={16} />
          <span className="sr-only">{t(STATE_LABEL[state])}</span>
        </span>
        <div className="mp-tally-name">
          <span className="mp-tally-name__text" title={name}>{name}</span>
          {!ingredient.active && <span className="mp-inv-pill shrink-0 self-center">{t("inactiveBadge")}</span>}
          {!tracked && <span className="mp-tally-name__cat">{t("nonInventoriable")}</span>}
          {ingredient.category && <span className="mp-tally-name__cat">{ingredient.category}</span>}
          {tags && tags.split(",").map((tag) => (
            <span key={tag} className="mp-tally-tag" data-tag={tag} title={tag === "moved" ? t("countReasonMovedTitle") : undefined}>{t(TAG_LABEL[tag])}</span>
          ))}
        </div>
      </div>

      <div className="mp-tally-row__nums">
        <div className="mp-tally-qty">
          {multi ? (
            <button
              type="button"
              className="mp-tally-partschip"
              aria-expanded={expanded}
              aria-controls={`count-row-${item.id}-parts`}
              aria-label={t("countPartsToggle", { count: partCount, name })}
              onClick={() => handlers.onToggleParts(item.id)}
            >
              {t("countPartsChip", { count: partCount })}
              <InvIcon name="chevronDown" size={14} />
            </button>
          ) : canEdit ? field(0) : null}
        </div>
        <div
          role="status"
          aria-label={t("countTotalLabel", { name })}
          className={"mp-tally-num mp-tally-total is-strong" + (multi || !canEdit ? " is-shown" : "") + (value == null ? " is-muted" : "")}
          data-tone={value === "invalid" ? "danger" : undefined}
        >
          {value === "invalid" ? "—" : value == null ? t("notCounted") : formatCountQty(value, kind, locale)}
        </div>
        <div className="mp-tally-figs">
          {showPreliminary && (
            <div
              className="mp-tally-num is-muted"
              title={[
                `${t("countInitialLabel")}: ${item.preliminaryQty == null ? t("notCounted") : formatCountQty(item.preliminaryQty, kind, locale)}`,
                item.preliminaryQty != null ? `${t("countInitialDifference")}: ${formatCountQty(item.preliminaryQty - item.expectedQty, kind, locale)}` : null,
                initialParts.length > 1 ? t("countInitialParts", { amounts: initialParts.map((part) => formatCountQty(part, kind, locale)).join(" + ") }) : null,
              ].filter(Boolean).join(" · ")}
            >
              <span className="mp-tally-num__label">{t("countFirstShort")}</span>
              {item.preliminaryQty == null ? "—" : formatCountQty(item.preliminaryQty, kind, locale)}
            </div>
          )}
          <div className="mp-tally-num is-muted" title={`${expectedLabel}: ${formatCountQty(baseline, kind, locale)}`}>
            <span className="mp-tally-num__label">{t("countExpectedShort")}</span>
            {formatCountQty(baseline, kind, locale)}
          </div>
          <div className="mp-tally-num" data-tone={diff == null || diff === 0 ? undefined : diff > 0 ? "ok" : "danger"}>
            {diff != null && diff !== 0 && <span className="sr-only">{t(diff < 0 ? "countShortage" : "countSurplus")}{" "}</span>}
            {diffText}
          </div>
        </div>
      </div>

      <div className="mp-tally-actions">
        {canEdit && (
          <button
            type="button"
            className="mp-tally-rowbtn"
            disabled={disabled || entries.length >= MAX_COUNT_PARTS}
            aria-label={t("countAddPartNamed", { name })}
            title={t("countAddPartTitle")}
            onClick={() => handlers.onAdd(item.id)}
          >
            <InvIcon name="plus" size={17} />
          </button>
        )}
        {codesEnabled && (
          <button
            type="button"
            className={"mp-tally-rowbtn" + (codesAccent && ingredient.active && tracked ? " is-accent" : "")}
            disabled={busy}
            aria-label={t("barcodeGroupLabel", { name })}
            title={t("barcodeSheetTitle")}
            onClick={() => handlers.onCodes(item.id)}
          >
            <InvIcon name="barcode" size={17} />
          </button>
        )}
      </div>

      {multi && expanded && (
        canEdit ? (
          <div id={`count-row-${item.id}-parts`} role="group" aria-label={t("countPartsGroup", { name })} className="mp-tally-parts">
            {entries.map((_, index) => (
              <div key={index} className="mp-tally-part">
                <span className="mp-tally-part__n" aria-hidden="true">{index + 1}</span>
                {field(index)}
                <button
                  type="button"
                  className="mp-tally-rowbtn"
                  disabled={disabled}
                  aria-label={t("countRemovePartLabel", { number: index + 1, name })}
                  onClick={() => handlers.onRemove(item.id, index)}
                >
                  <InvIcon name="close" size={15} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="mp-btn mp-btn--ghost mp-btn--xs"
              disabled={disabled || entries.length >= MAX_COUNT_PARTS}
              onClick={() => handlers.onAdd(item.id)}
            >
              {t("countAddPart")}
            </button>
          </div>
        ) : (
          <p id={`count-row-${item.id}-parts`} className="mp-tally-row__msg break-words">
            {t("countPartsBreakdown", { amounts: savedParts.map((part) => formatCountQty(part, kind, locale)).join(" + ") })}
          </p>
        )
      )}
      {errorText && <p id={msgId} role="alert" className="mp-tally-row__msg is-error">{errorText}</p>}
    </div>
  );
});
