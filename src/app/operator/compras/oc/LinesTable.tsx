"use client";

import type { KeyboardEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatMoney } from "@/lib/format";
import { Icon } from "@/components/ui/Icon";
import { DiscountControl } from "../DiscountControl";
import { IngredientPicker } from "./IngredientPicker";
import { DiscountCaption, DiscountCell, PriceInput, QtyInput, TaxSelect, TotalInput, UnitSelect } from "./cells";
import {
  gridKeyAction,
  isBlankLine,
  type GridKeyAction,
  type OcCol,
  type OcLine,
} from "./draft";
import { ISSUE_KEYS, issueId, type LineCtl } from "./lineCtl";

/**
 * Tabla de productos (escritorio): una fila por producto, editable como una
 * hoja de cálculo. Tab recorre las celdas; Enter abre la fila siguiente con
 * el foco en el insumo; Retroceso en una fila vacía la quita; ↑/↓ cambian
 * de fila en las columnas de números. Debajo de cada fila, solo si hace
 * falta, una franja con el impuesto al consumo, el aviso de insumo repetido
 * o los errores de sus celdas.
 */
export function LinesTable({
  lines,
  ctl,
  onGrid,
}: {
  lines: OcLine[];
  ctl: LineCtl;
  onGrid: (a: GridKeyAction) => void;
}) {
  const t = useTranslations("opErp");

  function onKeyDown(e: KeyboardEvent<HTMLTableElement>) {
    if (e.defaultPrevented) return;
    const target = e.target as HTMLElement;
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === "Enter" && !mod && target.tagName === "BUTTON") return;
    const cell = target.closest<HTMLElement>("[data-oc-col]");
    const body = target.closest<HTMLElement>("[data-oc-key]");
    if (!cell || !body) return;
    const key = Number(body.dataset.ocKey);
    const row = lines.findIndex((l) => l.key === key);
    if (row < 0) return;
    const next = lines[row + 1];
    const { action, preventDefault } = gridKeyAction({
      key: e.key,
      mod,
      shift: e.shiftKey,
      col: cell.dataset.ocCol as OcCol,
      row,
      rowCount: lines.length,
      rowBlank: isBlankLine(lines[row]!),
      nextRowBlank: next ? isBlankLine(next) : false,
      inputEmpty: target instanceof HTMLInputElement ? target.value === "" : false,
      listOpen: false,
    });
    if (preventDefault) e.preventDefault();
    if (action.kind !== "none") onGrid(action);
  }

  const th = "py-2 px-2 font-mono text-[10px] tracking-[0.12em] uppercase text-op-muted font-normal";
  return (
    <table className="w-full table-fixed border-separate border-spacing-0" onKeyDown={onKeyDown} data-testid="oc-lines-table">
      <colgroup>
        <col className="w-[30px]" />
        <col />
        <col className="w-[78px] xl:w-[88px]" />
        <col className="w-[116px] xl:w-[136px]" />
        <col className="w-[124px] xl:w-[140px]" />
        <col className="w-[96px] xl:w-[104px]" />
        <col className="w-[148px] xl:w-[172px]" />
        <col className="w-[124px] xl:w-[140px]" />
        <col className="w-[40px]" />
      </colgroup>
      <thead className="sticky top-0 z-10">
        <tr className="bg-op-surface">
          <th className={th + " text-right border-b border-op-border"} scope="col">
            <span className="sr-only">{t("ocLineCol")}</span>
          </th>
          <th className={th + " text-left border-b border-op-border"} scope="col">{t("fieldIngredient")}</th>
          <th className={th + " text-right border-b border-op-border"} scope="col">{t("fieldQty")}</th>
          <th className={th + " text-left border-b border-op-border"} scope="col">{t("ocColUnit")}</th>
          <th className={th + " text-right border-b border-op-border"} scope="col">{t("ocColPrice")}</th>
          <th className={th + " text-right border-b border-op-border"} scope="col">{t("discountLabel")}</th>
          <th className={th + " text-left border-b border-op-border"} scope="col">{t("poTaxLabel")}</th>
          <th className={th + " text-right border-b border-op-border"} scope="col">{t("totalLabel")}</th>
          <th className={th + " border-b border-op-border"} scope="col">
            <span className="sr-only">{t("removeLine")}</span>
          </th>
        </tr>
      </thead>
      {lines.map((l, i) => (
        <LineRow key={l.key} line={l} index={i} ctl={ctl} />
      ))}
    </table>
  );
}

function LineRow({ line: l, index, ctl }: { line: OcLine; index: number; ctl: LineCtl }) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const n = index + 1;
  const name = l.ingredient?.name ?? t("ocLineNumber", { n });
  const issues = ctl.visibleIssues(l);
  const dup = l.dupDismissed ? null : ctl.duplicateOf(l);
  const amounts = ctl.amounts(l.key);
  const showInc = l.tax.inc && l.ingredient != null;
  const hasStrip = showInc || dup != null || issues.item != null || issues.qty != null || issues.price != null;
  const td = "px-1 py-1.5 align-top";
  const label = (col: string) => `${col} · ${name}`;

  return (
    <tbody data-oc-key={l.key} data-oc-row={index} className="group scroll-mt-10 scroll-mb-14">
      <tr className="group-hover:bg-op-bg/60 group-focus-within:bg-op-bg/80 transition-colors">
        <td className={td + " pl-2 pr-1 pt-3.5 text-right text-[11px] text-op-muted tabular-nums select-none" + (hasStrip ? "" : " border-b border-op-border")}>
          {n}
        </td>
        <td data-oc-col="item" className={td + (hasStrip ? "" : " border-b border-op-border")}>
          <IngredientPicker
            floating
            options={ctl.options}
            value={l.ingredient}
            currency={ctl.currency}
            onPick={(o) => ctl.pick(l.key, o)}
            onCreate={(text) => ctl.createIngredient(l.key, text)}
            ariaLabel={t("ocItemOfLine", { n })}
            ariaInvalid={issues.item != null}
            ariaDescribedBy={issues.item ? issueId(l.key, "item") : undefined}
          />
        </td>
        <td data-oc-col="qty" className={td + (hasStrip ? "" : " border-b border-op-border")}>
          <QtyInput
            line={l}
            variant="cell"
            onChange={(qtyRaw) => ctl.patch(l.key, { qtyRaw })}
            onBlur={() => ctl.touch(l.key, "qty")}
            ariaLabel={label(t("fieldQty"))}
            invalid={issues.qty != null}
            describedBy={issues.qty ? issueId(l.key, "qty") : undefined}
          />
        </td>
        <td data-oc-col="unit" className={td + (hasStrip ? "" : " border-b border-op-border")}>
          <UnitSelect line={l} variant="cell" onChange={(u) => ctl.setUnit(l.key, u)} ariaLabel={label(t("ocColUnit"))} />
        </td>
        <td data-oc-col="price" className={td + (hasStrip ? "" : " border-b border-op-border")}>
          <PriceInput
            line={l}
            variant="cell"
            onChange={(priceRaw) => ctl.patch(l.key, { priceRaw, totalRaw: null, priceSource: null })}
            onBlur={() => ctl.touch(l.key, "price")}
            ariaLabel={label(t("ocColPrice"))}
            invalid={issues.price != null}
            describedBy={issues.price ? issueId(l.key, "price") : undefined}
          />
        </td>
        <td data-oc-col="disc" className={td + (hasStrip ? "" : " border-b border-op-border")}>
          <DiscountCell
            raw={l.discRaw}
            isPct={l.discIsPct}
            currency={ctl.currency}
            disabled={!l.ingredient}
            onChange={(discRaw, discIsPct) => ctl.patch(l.key, { discRaw, discIsPct })}
            ariaLabel={label(t("discountLabel"))}
          />
          <DiscountCaption cents={amounts?.lineDiscountCents ?? 0} currency={ctl.currency} />
        </td>
        <td data-oc-col="tax" className={td + (hasStrip ? "" : " border-b border-op-border")}>
          <TaxSelect
            choice={l.tax}
            rates={ctl.taxRates}
            variant="cell"
            disabled={!l.ingredient}
            onChange={(c) => ctl.setTax(l.key, c)}
            ariaLabel={label(t("poTaxLabel"))}
          />
        </td>
        <td data-oc-col="total" className={td + (hasStrip ? "" : " border-b border-op-border")}>
          <TotalInput
            line={l}
            variant="cell"
            onChange={(totalRaw) => ctl.patch(l.key, { totalRaw })}
            onRecalc={() => ctl.patch(l.key, { totalRaw: null })}
            onBlur={() => ctl.touch(l.key, "price")}
            ariaLabel={label(t("totalLabel"))}
          />
        </td>
        <td className={td + " pr-2" + (hasStrip ? "" : " border-b border-op-border")}>
          <button
            type="button"
            onClick={() => ctl.remove(l.key)}
            aria-label={t("ocRemoveLine", { n })}
            title={t("ocRemoveLine", { n })}
            data-oc-skip-enter=""
            className="w-9 h-9 inline-flex items-center justify-center rounded-md text-op-muted opacity-60 group-hover:opacity-100 focus-visible:opacity-100 hover:text-danger hover:bg-danger/10 transition"
          >
            <Icon name="close" width={16} height={16} />
          </button>
        </td>
      </tr>
      {hasStrip && (
        <tr className="group-hover:bg-op-bg/60 group-focus-within:bg-op-bg/80">
          <td className="border-b border-op-border" />
          <td colSpan={8} className="px-1 pb-2 border-b border-op-border">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-2">
              {(["item", "qty", "price"] as const).map((col) =>
                issues[col] ? (
                  <span key={col} id={issueId(l.key, col)} role="alert" className="inline-flex items-center gap-1.5 text-xs text-danger">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                      <circle cx="12" cy="12" r="9" />
                      <path d="M12 7v6m0 4h.01" />
                    </svg>
                    {t(ISSUE_KEYS[issues[col]!])}
                  </span>
                ) : null,
              )}
              {dup && (
                <span className="inline-flex flex-wrap items-center gap-2 text-xs text-op-text bg-warn/15 rounded-md px-2 py-1">
                  <DupIcon />
                  <span>{t("ocDupNotice", { name: dup.line.ingredient?.name ?? "", n: dup.index + 1 })}</span>
                  <button
                    type="button"
                    onClick={() => ctl.merge(dup.line.key, l.key)}
                    className="font-medium underline underline-offset-2 hover:no-underline"
                    data-oc-skip-enter=""
                  >
                    {t("ocDupMerge", { n: dup.index + 1 })}
                  </button>
                  <button
                    type="button"
                    onClick={() => ctl.patch(l.key, { dupDismissed: true })}
                    className="text-op-muted hover:text-ink"
                    data-oc-skip-enter=""
                  >
                    {t("ocDupKeep")}
                  </button>
                </span>
              )}
              {showInc && (
                <span className="inline-flex items-center gap-2 text-xs text-op-muted ml-auto">
                  <span>{t("ocIncOfLine")}</span>
                  <DiscountControl
                    inline
                    label={t("ocIncOfLine")}
                    raw={l.incRaw}
                    isPct={l.incIsPct}
                    currency={ctl.currency}
                    placeholder="0"
                    onChange={(incRaw, incIsPct) => ctl.patch(l.key, { incRaw, incIsPct })}
                  />
                  {amounts && amounts.incCents > 0 && (
                    <span className="tabular-nums text-op-text">{formatMoney(amounts.incCents, { currency: ctl.currency, locale, fractionDigits: "auto" })}</span>
                  )}
                </span>
              )}
            </div>
          </td>
        </tr>
      )}
    </tbody>
  );
}

/** Aviso de insumo repetido (dos hojas). */
export function DupIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="text-warn shrink-0">
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </svg>
  );
}
